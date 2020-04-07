/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import {
  ApolloServerPlugin,
  GraphQLRequestContext
} from 'apollo-server-plugin-base'
import Logger from 'bunyan'
import { includes, isString } from 'lodash'
import { DeepPartial } from '../types'
import { createLogger } from './create-logger'

interface CreateLoggerPluginOptions {
  logger?: Logger
  logResponseErrors?: boolean
}

interface LensOptions extends Required<CreateLoggerPluginOptions> {}

const lens = (
  context: DeepPartial<GraphQLRequestContext>,
  options: LensOptions
) => {
  if (
    isString(context.operationName) &&
    includes(['introspectionquery'], context.operationName.toLowerCase())
  ) {
    return
  }

  const hasErrors = (context.errors?.length ?? 0) > 0

  const graphql = {
    request: {
      operationName: context.request?.operationName,
      query: context.request?.query,
      variables: context.request?.variables
    },
    response: {
      data: context.response?.data,
      ...(options.logResponseErrors ? { errors: context.response?.errors } : {})
    },
    errors: context.errors,
    metrics: context.metrics,
    queryHash: context.queryHash
  }
  options.logger[hasErrors ? 'error' : 'info']({ graphql }, 'GraphQL Query')
}

export const createLoggerPlugin = (
  options?: CreateLoggerPluginOptions
): ApolloServerPlugin => {
  // const opts: LensOptions = {
  //   ...options
  // }
  const logger = options?.logger !== undefined ? options.logger : createLogger()
  const logResponseErrors = options?.logResponseErrors ?? false

  return {
    requestDidStart() {
      return {
        willSendResponse(context) {
          lens(context, { logger, logResponseErrors })
        }
      }
    }
  }
}
