/*
eslint-disable
  @typescript-eslint/no-floating-promises,
  @typescript-eslint/promise-function-async,
  @typescript-eslint/strict-boolean-expressions
*/

import {
  RenderPageOptions as PlaygroundRenderPageOptions,
  renderPlaygroundPage
} from '@apollographql/graphql-playground-html'
import {
  ApolloServerBase,
  GraphQLOptions,
  HttpQueryError,
  runHttpQuery
} from 'apollo-server-core'
import { Headers } from 'apollo-server-env'
import {
  Callback,
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontResultResponse,
  Context as LambdaContext
} from 'aws-lambda'
import { compact, flatMap, map } from 'lodash'
import querystring from 'querystring'
import { URL } from 'url'
import {
  CloudFrontApolloServerEndpoints,
  Config,
  CreateHandlerOptions
} from './types'

const cloudFrontHeaders = (input: Record<string, string>): CloudFrontHeaders =>
  Object.fromEntries(
    compact(
      map(input, (value, key):
        | [string, [{ key: string; value: string }]]
        | undefined => {
        const lowercaseKey = key.toLowerCase()

        return lowercaseKey === 'content-length'
          ? undefined
          : [
              lowercaseKey,
              [
                {
                  key,
                  value
                }
              ]
            ]
      })
    )
  )

export class ApolloServer extends ApolloServerBase {
  private readonly endpoints: CloudFrontApolloServerEndpoints
  // If you feel tempted to add an option to this constructor. Please consider
  // another place, since the documentation becomes much more complicated when
  // the constructor is not longer shared between all integration
  constructor(options: Config) {
    if (process.env.ENGINE_API_KEY ?? options.engine) {
      options.engine = {
        sendReportsImmediately: true,
        ...(typeof options.engine !== 'boolean' ? options.engine : {})
      }
    }

    super(options)

    this.endpoints = {
      playground: options.endpoints?.playground ?? '/graphql/playground',
      graphql: options.endpoints?.graphql ?? '/graphql/endpoint',
      healthCheck:
        options.endpoints?.healthCheck ??
        '/graphql/.well-known/apollo/server-health'
    }
  }

  // This translates the arguments from the middleware into graphQL options It
  // provides typings for the integration specific behavior, ideally this would
  // be propagated with a generic to the super class
  createGraphQLServerOptions(
    event: CloudFrontRequestEvent,
    context: LambdaContext
  ): Promise<GraphQLOptions> {
    return super.graphQLServerOptions({ event, context })
  }

  public createHandler(
    { cors, onHealthCheck }: CreateHandlerOptions = {
      cors: undefined,
      onHealthCheck: undefined
    }
  ): CloudFrontRequestHandler {
    // We will kick off the `willStart` event once for the server, and then
    // await it before processing any requests by incorporating its `await` into
    // the GraphQLServerOptions function which is called before each request.
    const promiseWillStart = this.willStart()

    const corsHeaders = new Headers()

    if (cors) {
      if (cors.methods) {
        if (typeof cors.methods === 'string') {
          corsHeaders.set('access-control-allow-methods', cors.methods)
        } else if (Array.isArray(cors.methods)) {
          corsHeaders.set(
            'access-control-allow-methods',
            cors.methods.join(',')
          )
        }
      }

      if (cors.allowedHeaders) {
        if (typeof cors.allowedHeaders === 'string') {
          corsHeaders.set('access-control-allow-headers', cors.allowedHeaders)
        } else if (Array.isArray(cors.allowedHeaders)) {
          corsHeaders.set(
            'access-control-allow-headers',
            cors.allowedHeaders.join(',')
          )
        }
      }

      if (cors.exposedHeaders) {
        if (typeof cors.exposedHeaders === 'string') {
          corsHeaders.set('access-control-expose-headers', cors.exposedHeaders)
        } else if (Array.isArray(cors.exposedHeaders)) {
          corsHeaders.set(
            'access-control-expose-headers',
            cors.exposedHeaders.join(',')
          )
        }
      }

      if (cors.credentials) {
        corsHeaders.set('access-control-allow-credentials', 'true')
      }
      if (typeof cors.maxAge === 'number') {
        corsHeaders.set('access-control-max-age', cors.maxAge.toString())
      }
    }

    return (event, context, callback: Callback<CloudFrontResultResponse>) => {
      const request = event.Records[0].cf.request

      const headers = flatMap<CloudFrontHeaders, [string, string]>(
        request.headers,
        (value, lowercaseKey) =>
          map(
            value,
            ({ value }) =>
              [/* key ?? */ lowercaseKey, value] as [string, string]
          )
      )

      const method = request.method
      const url = new URL(request.uri, 'https://example.com')
      const params = querystring.parse(request.querystring)

      // We re-load the headers into a Fetch API-compatible `Headers`
      // interface within `graphqlLambda`, but we still need to respect the
      // case-insensitivity within this logic here, so we'll need to do it
      // twice since it's not accessible to us otherwise, right now.
      const eventHeaders = new Headers(headers)

      // Make a request-specific copy of the CORS headers, based on the server
      // global CORS headers we've set above.
      const requestCorsHeaders = new Headers(corsHeaders)

      if (cors?.origin) {
        const requestOrigin = eventHeaders.get('origin')
        if (typeof cors.origin === 'string') {
          requestCorsHeaders.set('access-control-allow-origin', cors.origin)
        } else if (
          requestOrigin &&
          (typeof cors.origin === 'boolean' ||
            (Array.isArray(cors.origin) &&
              requestOrigin &&
              cors.origin.includes(requestOrigin)))
        ) {
          requestCorsHeaders.set('access-control-allow-origin', requestOrigin)
        }

        const requestAccessControlRequestHeaders = eventHeaders.get(
          'access-control-request-headers'
        )
        if (!cors.allowedHeaders && requestAccessControlRequestHeaders) {
          requestCorsHeaders.set(
            'access-control-allow-headers',
            requestAccessControlRequestHeaders
          )
        }
      }

      // Convert the `Headers` into an object which can be spread into the
      // various headers objects below.
      // Note: while Object.fromEntries simplifies this code, it's only currently
      //       supported in Node 12 (we support >=6)
      const requestCorsHeadersObject = Array.from(requestCorsHeaders).reduce<
        Record<string, string>
      >((headersObject, [key, value]) => {
        headersObject[key] = value
        return headersObject
      }, {})

      if (method === 'OPTIONS') {
        context.callbackWaitsForEmptyEventLoop = false

        return callback(null, {
          body: '',
          status: '204',
          statusDescription: 'No Content',
          headers: cloudFrontHeaders({
            ...requestCorsHeadersObject
          })
        })
      }

      if (url.pathname === this.endpoints.healthCheck) {
        const successfulResponse: CloudFrontResultResponse = {
          body: JSON.stringify({ status: 'pass' }),
          status: '200',
          statusDescription: 'Ok',
          headers: cloudFrontHeaders({
            'Content-Type': 'application/json',
            ...requestCorsHeadersObject
          })
        }

        if (onHealthCheck) {
          onHealthCheck(event)
            .then(() => {
              return callback(null, successfulResponse)
            })
            .catch(() => {
              return callback(null, {
                body: JSON.stringify({ status: 'fail' }),
                status: '503',
                headers: cloudFrontHeaders({
                  'Content-Type': 'application/json',
                  ...requestCorsHeadersObject
                })
              })
            })
        } else {
          return callback(null, successfulResponse)
        }
      }

      if (this.playgroundOptions && method === 'GET') {
        const path = url.pathname

        if (path === this.endpoints.playground) {
          const playgroundRenderPageOptions: PlaygroundRenderPageOptions = {
            endpoint: this.endpoints.graphql,
            ...this.playgroundOptions
          }

          return callback(null, {
            body: renderPlaygroundPage(playgroundRenderPageOptions),
            status: '200',
            statusDescription: 'Ok',
            headers: cloudFrontHeaders({
              'Content-Type': 'text/html',
              ...requestCorsHeadersObject
            })
          })
        }
      }

      promiseWillStart
        .then(() => this.createGraphQLServerOptions(event, context))
        .then((options) => {
          context.callbackWaitsForEmptyEventLoop = false

          const eventBody =
            request.body?.data !== undefined
              ? request.body.encoding === 'text'
                ? request.body.data
                : Buffer.from(request.body.data, 'base64').toString()
              : undefined

          if (method === 'POST' && !eventBody) {
            return callback(null, {
              body: 'POST body missing.',
              status: '500',
              statusDescription: 'Internal Server Error',
              headers: cloudFrontHeaders({
                ...requestCorsHeadersObject
              })
            })
          }

          runHttpQuery([event, context], {
            method,
            options,
            query:
              method === 'POST' && eventBody ? JSON.parse(eventBody) : params,
            request: {
              url: url.pathname,
              method,
              headers: eventHeaders
            }
          }).then(
            ({ graphqlResponse, responseInit }) => {
              callback(null, {
                body: graphqlResponse,
                status: '200',
                statusDescription: 'Ok',
                headers: cloudFrontHeaders({
                  ...responseInit.headers,
                  ...requestCorsHeadersObject
                })
              })
            },
            (error: HttpQueryError) => {
              if (error.name !== 'HttpQueryError') return callback(error)
              callback(null, {
                body: error.message,
                status: `${error.statusCode}`,
                statusDescription: 'Bad Request',
                headers: cloudFrontHeaders({
                  ...error.headers,
                  ...requestCorsHeadersObject
                })
              })
            }
          )
        })
    }
  }
}
