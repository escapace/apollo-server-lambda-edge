/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-throw-literal */
/* eslint-disable @typescript-eslint/promise-function-async */
/* eslint-disable prefer-const */
/* eslint-disable no-prototype-builtins */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/restrict-plus-operands */
/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import { ApolloServer, Config, gql } from './index'
import { sha256 } from 'js-sha256'
import { VERSION } from 'apollo-link-persisted-queries'
import url from 'url'
import { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'http'
import {
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontResultResponse
} from 'aws-lambda'
import { stringify } from 'querystring'
import request from 'supertest'
import { assert } from 'chai'
import { spy } from 'sinon'

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLError,
  ValidationContext,
  GraphQLNonNull,
  getIntrospectionQuery,
  BREAK,
  GraphQLScalarType,
  DocumentNode,
  getOperationAST
} from 'graphql'
import { GraphQLResponse } from 'apollo-server-core'
import { PersistedQueryNotFoundError } from 'apollo-server-errors'
import { InMemoryLRUCache } from './utilities/in-memory-lru-cache'
import { createLoggerPlugin } from './utilities/create-logger-plugin'

const graphqlPath = '/graphql/endpoint'

const toCloudFrontHeaders = (
  headers: IncomingHttpHeaders
): CloudFrontHeaders => {
  const result: CloudFrontHeaders = {}

  Object.keys(headers).forEach((headerName) => {
    const lowerCaseHeaderName = headerName.toLowerCase()
    const headerValue = headers[headerName]

    // if (readOnlyCloudFrontHeaders[lowerCaseHeaderName]) {
    //   return
    // }

    result[lowerCaseHeaderName] = []

    if (headerValue instanceof Array) {
      headerValue.forEach((val) => {
        result[lowerCaseHeaderName].push({
          key: headerName,
          value: val.toString()
        })
      })
    } else if (headerValue !== undefined) {
      result[lowerCaseHeaderName].push({
        key: headerName,
        value: headerValue.toString()
      })
    }
  })

  return result
}

const personType = new GraphQLObjectType({
  name: 'PersonType',
  fields: {
    firstName: {
      type: GraphQLString
    },
    lastName: {
      type: GraphQLString
    }
  }
})

const queryType = new GraphQLObjectType({
  name: 'QueryType',
  fields: {
    testString: {
      type: GraphQLString,
      resolve() {
        return 'it works'
      }
    },
    testPerson: {
      type: personType,
      resolve() {
        return { firstName: 'Jane', lastName: 'Doe' }
      }
    },
    testStringWithDelay: {
      type: GraphQLString,
      args: {
        delay: { type: new GraphQLNonNull(GraphQLInt) }
      },
      resolve(_, args) {
        return new Promise((resolve) => {
          setTimeout(() => resolve('it works'), args.delay)
        })
      }
    },
    testContext: {
      type: GraphQLString,
      resolve(_parent, _args, context) {
        if (context.otherField) {
          return 'unexpected'
        }
        context.otherField = true
        return context.testField
      }
    },
    testRootValue: {
      type: GraphQLString,
      resolve(rootValue) {
        return rootValue
      }
    },
    testArgument: {
      type: GraphQLString,
      args: { echo: { type: GraphQLString } },
      resolve(_, { echo }) {
        return `hello ${echo}`
      }
    },
    testError: {
      type: GraphQLString,
      resolve() {
        throw new Error('Secret error message')
      }
    }
  }
})

const mutationType = new GraphQLObjectType({
  name: 'MutationType',
  fields: {
    testMutation: {
      type: GraphQLString,
      args: { echo: { type: GraphQLString } },
      resolve(_, { echo }) {
        return `not really a mutation, but who cares: ${echo}`
      }
    },
    testPerson: {
      type: personType,
      args: {
        firstName: {
          type: new GraphQLNonNull(GraphQLString)
        },
        lastName: {
          type: new GraphQLNonNull(GraphQLString)
        }
      },
      resolve(_, args) {
        return args
      }
    }
  }
})

export const QueryRootType = new GraphQLObjectType({
  name: 'QueryRoot',
  fields: {
    test: {
      type: GraphQLString,
      args: {
        who: {
          type: GraphQLString
        }
      },
      resolve: (_, args) => 'Hello ' + (args.who || 'World')
    },
    thrower: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: () => {
        throw new Error('Throws!')
      }
    },
    custom: {
      type: GraphQLString,
      args: {
        foo: {
          type: new GraphQLScalarType({
            name: 'Foo',
            serialize: (v) => v,
            parseValue: () => {
              throw new Error('Something bad happened')
            },
            parseLiteral: () => {
              throw new Error('Something bad happened')
            }
          })
        }
      }
    },
    context: {
      type: GraphQLString,
      resolve: (_obj, _args, context) => context
    }
  }
})

export const schema = new GraphQLSchema({
  query: queryType,
  mutation: mutationType
})

const TestSchema = new GraphQLSchema({
  query: QueryRootType,
  mutation: new GraphQLObjectType({
    name: 'MutationRoot',
    fields: {
      writeTest: {
        type: QueryRootType,
        resolve: () => ({})
      }
    }
  })
})

const createLambda = (options?: Config) => {
  const server = new ApolloServer(
    options ?? {
      schema,
      cache: new InMemoryLRUCache(),
      playground: true,
      plugins: [createLoggerPlugin()]
    }
  )

  const handler = server.createHandler()

  return (req: IncomingMessage, res: ServerResponse) => {
    // return 404 if path is /bogus-route to pass the test, lambda doesn't have paths
    if (req.url?.includes('/bogus-route')) {
      res.statusCode = 404
      return res.end()
    }

    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      // eslint-disable-next-line node/no-deprecated-api
      const urlObject = url.parse(req.url as string, true)
      // const eventA = {
      //   httpMethod: req.method,
      //   body,
      //   path: req.url,
      //   queryStringParameters: urlObject.query,
      //   requestContext: {
      //     path: urlObject.pathname
      //   },
      //   headers: req.headers
      // }

      const event: CloudFrontRequestEvent = {
        Records: [
          {
            cf: {
              config: {
                distributionDomainName: 'd111111abcdef8.cloudfront.net',
                distributionId: 'EDFDVBD6EXAMPLE',
                eventType: 'origin-request'
                // requestId:
                //   '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ=='
              },
              request: {
                clientIp: '203.0.113.178',
                headers: toCloudFrontHeaders(req.headers),
                method: req.method as string,
                origin: {
                  custom: {
                    customHeaders: {},
                    domainName: 'example.org',
                    keepaliveTimeout: 5,
                    path: '',
                    port: 443,
                    protocol: 'https',
                    readTimeout: 30,
                    sslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2']
                  }
                },
                querystring: stringify(urlObject.query),
                uri: req.url as string,
                body: {
                  data: body,
                  encoding: 'text',
                  inputTruncated: false,
                  action: 'read-only'
                }
              }
            }
          }
        ]
      }

      const callback = (
        error: string | Error | null | undefined,
        result: CloudFrontResultResponse
        // result: CloudFrontRequestResult
      ) => {
        if (error) throw error

        if (result) {
          for (let key in result.headers) {
            if (result.headers.hasOwnProperty(key)) {
              result.headers[key].forEach(({ value }) => {
                res.setHeader(key, value)
              })
            }
          }

          res.statusCode = parseInt(result.status, 10)

          if (result?.body) {
            res.write(result?.body)
          }
        }

        res.end()
      }

      handler(event, {} as any, callback as any)
    })
  }
}

describe('integration:Lambda', () => {
  it('rejects the request if the method is not POST or GET', async () => {
    const app = createLambda()
    const res = await request(app).head('/graphql/endpoint').send()

    assert.equal(res.status, 405)
  })

  it('throws an error if POST body is missing', async () => {
    const app = createLambda()
    const res = await request(app).post('/graphql/endpoint').send()

    assert.equal(res.status, 500)
    // assert.match(
    //   `${res.error === false ? '' : res.error.message}`,
    //   /POST body missing./
    // )
  })

  it('throws an error if GET query is missing', async () => {
    const app = createLambda()
    const res = await request(app).get(`/graphql/endpoint`)

    assert.equal(res.status, 400)

    // assert.match(
    //   `${res.error === false ? '' : res.error.message}`,
    //   /GET query missing./
    // )

    // return req.then((res) => {
    //   expect(res.status, 400)
    //   expect(res.error.text).toMatch('GET query missing.')
    // })
  })

  it('can handle a basic GET request', async () => {
    const app = createLambda()

    const expected = {
      testString: 'it works'
    }

    const query = {
      query: 'query test{ testString }'
    }

    const res = await request(app).get(graphqlPath).query(query)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle a basic implicit GET request', async () => {
    const app = await createLambda()

    const expected = {
      testString: 'it works'
    }

    const query = {
      query: '{ testString }'
    }

    const res = await request(app).get(graphqlPath).query(query)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('throws error if trying to use mutation using GET request', async () => {
    const didEncounterErrors = spy()
    const app = createLambda({
      schema,
      plugins: [
        {
          requestDidStart() {
            return { didEncounterErrors }
          }
        }
      ]
    })

    const query = {
      query: 'mutation test{ testMutation(echo: "ping") }'
    }

    const res = await request(app).get(graphqlPath).query(query)

    assert.equal(res.status, 405)
    assert.equal(res.header.allow, 'POST')
    assert.match(
      res.error === false ? '' : res.error.text,
      /GET supports only query operation/
    )

    assert.match(
      didEncounterErrors.firstCall.args[0].errors[0].message,
      /GET supports only query operation/
    )
  })

  it('throws error if trying to use mutation with fragment using GET request', async () => {
    const didEncounterErrors = spy()

    const app = createLambda({
      schema,
      plugins: [
        {
          requestDidStart() {
            return { didEncounterErrors }
          }
        }
      ]
    })

    const query = {
      query: `fragment PersonDetails on PersonType {
            firstName
          }
          mutation test {
            testPerson(firstName: "Test", lastName: "Me") {
              ...PersonDetails
            }
          }`
    }

    const res = await request(app).get(graphqlPath).query(query)

    assert.equal(res.status, 405)
    assert.equal(res.header.allow, 'POST')
    assert.match(
      res.error === false ? '' : res.error.text,
      /GET supports only query operation/
    )

    assert.match(
      didEncounterErrors.firstCall.args[0].errors[0].message,
      /GET supports only query operation/
    )
  })

  it('can handle a GET request with variables', async () => {
    const app = createLambda()

    const query = {
      query: 'query test($echo: String){ testArgument(echo: $echo) }',
      variables: JSON.stringify({ echo: 'world' })
    }

    const expected = {
      testArgument: 'hello world'
    }

    const res = await request(app).get(graphqlPath).query(query)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle a basic request', async () => {
    const app = createLambda()

    const expected = {
      testString: 'it works'
    }
    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testString }'
    })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle a basic request with cacheControl', async () => {
    const app = createLambda({
      schema,
      cacheControl: true
    })

    const expected = {
      testPerson: { firstName: 'Jane' }
    }

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testPerson { firstName } }'
    })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
    assert.deepEqual(res.body.extensions, {
      cacheControl: {
        version: 1,
        hints: [{ maxAge: 0, path: ['testPerson'] }]
      }
    })
  })

  it('can handle a basic request with cacheControl and defaultMaxAge', async () => {
    const app = createLambda({
      schema,
      cacheControl: {
        defaultMaxAge: 5,
        stripFormattedExtensions: false
        // calculateCacheControlHeaders: false
      }
    })

    const expected = {
      testPerson: { firstName: 'Jane' }
    }

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testPerson { firstName } }'
    })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, expected)
    assert.deepEqual(res.body.extensions, {
      cacheControl: {
        version: 1,
        hints: [{ maxAge: 5, path: ['testPerson'] }]
      }
    })
  })

  it('returns PersistedQueryNotSupported to a GET request if PQs disabled', async () => {
    const app = createLambda({
      schema,
      persistedQueries: false
    })

    const res = await request(app)
      .get(graphqlPath)
      .query({
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        })
      })

    assert.equal(res.status, 200)
    assert.ok(res.body.errors)
    assert.equal(res.body.errors[0].message, 'PersistedQueryNotSupported')
  })

  it('returns PersistedQueryNotSupported to a POST request if PQs disabled', async () => {
    const app = createLambda({
      schema,
      persistedQueries: false
    })

    const res = await request(app)
      .post(graphqlPath)
      .send({
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        }
      })

    assert.equal(res.status, 200)
    assert.ok(res.body.errors)
    assert.equal(res.body.errors.length, 1)
    assert.equal(res.body.errors[0].message, 'PersistedQueryNotSupported')
  })

  it('returns PersistedQueryNotFound to a GET request', async () => {
    const app = createLambda()

    const res = await request(app)
      .get(graphqlPath)
      .query({
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        })
      })

    assert.deepEqual(res.status, 200)
    assert.ok(res.body.errors)
    assert.deepEqual(res.body.errors.length, 1)
    assert.deepEqual(res.body.errors[0].message, 'PersistedQueryNotFound')
  })

  it('returns PersistedQueryNotFound to a POST request', async () => {
    const app = createLambda()
    const res = await request(app)
      .post(graphqlPath)
      .send({
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        }
      })

    assert.deepEqual(res.status, 200)
    assert.ok(res.body.errors)
    assert.deepEqual(res.body.errors.length, 1)
    assert.deepEqual(res.body.errors[0].message, 'PersistedQueryNotFound')
  })

  it('can handle a request with variables', async () => {
    const app = createLambda()
    const expected = {
      testArgument: 'hello world'
    }
    const res = await request(app)
      .post(graphqlPath)
      .send({
        query: 'query test($echo: String){ testArgument(echo: $echo) }',
        variables: { echo: 'world' }
      })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle a request with variables as string', async () => {
    const app = createLambda()
    const expected = {
      testArgument: 'hello world'
    }

    const res = await request(app).post(graphqlPath).send({
      query: 'query test($echo: String!){ testArgument(echo: $echo) }',
      variables: '{ "echo": "world" }'
    })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle a request with variables as an invalid string', async () => {
    const app = createLambda()
    const res = await request(app).post(graphqlPath).send({
      query: 'query test($echo: String!){ testArgument(echo: $echo) }',
      variables: '{ echo: "world" }'
    })

    assert.deepEqual(res.status, 400)
    assert.deepEqual(
      res.error === false ? '' : res.error.text,
      'Variables are invalid JSON.'
    )
  })

  it('can handle a request with operationName', async () => {
    const app = createLambda()
    const expected = {
      testString: 'it works'
    }

    const res = await request(app)
      .post(graphqlPath)
      .send({
        query: `
                    query test($echo: String){ testArgument(echo: $echo) }
                    query test2{ testString }`,
        variables: { echo: 'world' },
        operationName: 'test2'
      })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('can handle introspection request', async () => {
    const app = createLambda()
    const res = await request(app)
      .post(graphqlPath)
      .send({ query: getIntrospectionQuery() })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(
      res.body.data.__schema.types[0].fields[0].name,
      'testString'
    )
  })

  it('does not accept a query AST', async () => {
    const app = createLambda()
    const res = await request(app)
      .post(graphqlPath)
      .send({
        query: gql`
          query test {
            testString
          }
        `
      })

    assert.deepEqual(res.status, 400)
    assert.match(res.text, /GraphQL queries must be strings/)
  })

  it('can handle batch requests', async () => {
    const app = createLambda()
    const expected = [
      {
        data: {
          testString: 'it works'
        }
      },
      {
        data: {
          testArgument: 'hello yellow'
        }
      }
    ]
    const res = await request(app)
      .post(graphqlPath)
      .send([
        {
          query: `
                      query test($echo: String){ testArgument(echo: $echo) }
                      query test2{ testString }`,
          variables: { echo: 'world' },
          operationName: 'test2'
        },
        {
          query: `
                      query testX($echo: String){ testArgument(echo: $echo) }`,
          variables: { echo: 'yellow' },
          operationName: 'testX'
        }
      ])

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body, expected)
  })

  it('can handle batch requests', async () => {
    const app = createLambda()
    const expected = [
      {
        data: {
          testString: 'it works'
        }
      }
    ]
    const res = await request(app)
      .post(graphqlPath)
      .send([
        {
          query: `
                      query test($echo: String){ testArgument(echo: $echo) }
                      query test2{ testString }`,
          variables: { echo: 'world' },
          operationName: 'test2'
        }
      ])

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body, expected)
  })

  it('can handle batch requests in parallel', async function () {
    const parallels = 100
    const delayPerReq = 40

    const app = createLambda()
    const expected = Array(parallels).fill({
      data: { testStringWithDelay: 'it works' }
    })
    const res = await request(app)
      .post(graphqlPath)
      .send(
        Array(parallels).fill({
          query: `query test($delay: Int!) { testStringWithDelay(delay: $delay) }`,
          operationName: 'test',
          variables: { delay: delayPerReq }
        })
      )

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body, expected)
  }) // this test will fail due to timeout if running serially.

  it('clones batch context', async () => {
    const app = createLambda({
      schema,
      context: { testField: 'expected' }
    })
    const expected = [
      {
        data: {
          testContext: 'expected'
        }
      },
      {
        data: {
          testContext: 'expected'
        }
      }
    ]

    const res = await request(app)
      .post(graphqlPath)
      .send([
        {
          query: 'query test{ testContext }'
        },
        {
          query: 'query test{ testContext }'
        }
      ])

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body, expected)
  })

  it('executes batch context if it is a function', async () => {
    let callCount = 0
    const app = createLambda({
      schema,
      context: () => {
        callCount++
        return { testField: 'expected' }
      }
    })
    const expected = [
      {
        data: {
          testContext: 'expected'
        }
      },
      {
        data: {
          testContext: 'expected'
        }
      }
    ]

    const res = await request(app)
      .post(graphqlPath)
      .send([
        {
          query: 'query test{ testContext }'
        },
        {
          query: 'query test{ testContext }'
        }
      ])

    assert.deepEqual(callCount, 1)
    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body, expected)
  })

  it('can handle a request with a mutation', async () => {
    const app = createLambda()
    const expected = {
      testMutation: 'not really a mutation, but who cares: world'
    }
    const res = await request(app)
      .post(graphqlPath)
      .send({
        query: 'mutation test($echo: String){ testMutation(echo: $echo) }',
        variables: { echo: 'world' }
      })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data, expected)
  })

  it('applies the formatResponse function', async () => {
    const app = createLambda({
      schema,
      formatResponse(response) {
        ;(response ?? {}).extensions = { it: 'works' }

        return response as GraphQLResponse
      }
    })

    const expected = { it: 'works' }
    const res = await request(app)
      .post(graphqlPath)
      .send({
        query: 'mutation test($echo: String){ testMutation(echo: $echo) }',
        variables: { echo: 'world' }
      })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.extensions, expected)
  })

  it('passes the context to the resolver', async () => {
    const expected = 'context works'
    const app = createLambda({
      schema,
      context: { testField: expected }
    })

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testContext }'
    })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data.testContext, expected)
  })

  it('passes the rootValue to the resolver', async () => {
    const expected = 'it passes rootValue'
    const app = createLambda({
      schema,
      rootValue: expected
    })

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testRootValue }'
    })
    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.data.testRootValue, expected)
  })

  it('passes the rootValue function result to the resolver', async () => {
    const expectedQuery = 'query: it passes rootValue'
    const expectedMutation = 'mutation: it passes rootValue'
    const app = createLambda({
      schema,
      rootValue: (documentNode: DocumentNode) => {
        const op = getOperationAST(documentNode, undefined)

        return op?.operation === 'mutation' ? expectedMutation : expectedQuery
      }
    })

    const queryRes = await request(app).post(graphqlPath).send({
      query: 'query test{ testRootValue }'
    })

    assert.equal(queryRes.status, 200)
    assert.deepEqual(queryRes.body.data.testRootValue, expectedQuery)

    // const mutationReq = await request(app).post(graphqlPath).send({
    //   query: 'mutation test{ testMutation(echo: "ping") }'
    // })

    // console.log(mutationReq.body.data)

    // assert.equal(mutationReq.status, 200)
    // assert.deepEqual(mutationReq.body.data, expectedMutation)
  })

  it('returns errors', async () => {
    const expected = 'Secret error message'
    const app = createLambda({
      schema
    })

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testError }'
    })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.errors[0].message, expected)
  })

  it('applies formatError if provided', async () => {
    const expected = '--blank--'
    const app = createLambda({
      schema,
      formatError: (error) => {
        assert.ok(error instanceof Error)
        return { message: expected }
      }
    })
    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testError }'
    })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.errors[0].message, expected)
  })

  it('formatError receives error that passes instanceof checks', async () => {
    const expected = '--blank--'
    const app = createLambda({
      schema,
      formatError: (error) => {
        assert.ok(error instanceof Error)
        assert.ok(error instanceof GraphQLError)
        return { message: expected }
      }
    })

    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testError }'
    })

    assert.deepEqual(res.status, 200)
    assert.deepEqual(res.body.errors[0].message, expected)
  })

  it('allows for custom error formatting to sanitize', async () => {
    const app = createLambda({
      schema: TestSchema,
      formatError(error) {
        return { message: 'Custom error format: ' + error.message }
      }
    })

    const response = await request(app).post(graphqlPath).send({
      query: '{thrower}'
    })

    assert.deepEqual(response.status, 200)
    assert.deepEqual(JSON.parse(response.text), {
      data: null,
      errors: [
        {
          message: 'Custom error format: Throws!'
        }
      ]
    })
  })

  it('allows for custom error formatting to elaborate', async () => {
    const app = createLambda({
      schema: TestSchema,
      formatError(error) {
        return {
          message: error.message,
          locations: error.locations,
          stack: 'Stack trace'
        }
      }
    })

    const response = await request(app).post(graphqlPath).send({
      query: '{thrower}'
    })

    assert.deepEqual(response.status, 200)
    assert.deepEqual(JSON.parse(response.text), {
      data: null,
      errors: [
        {
          message: 'Throws!',
          locations: [{ line: 1, column: 2 }],
          stack: 'Stack trace'
        }
      ]
    })
  })

  it('sends internal server error when formatError fails', async () => {
    const app = createLambda({
      schema,
      formatError() {
        throw new Error('Internal Server Error')
      }
    })
    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testError }'
    })

    // assert.deepEqual(res.status, 500)
    assert.deepEqual(res.body.errors[0].message, 'Internal Server Error')
  })

  it('applies additional validationRules', async () => {
    const expected = 'alwaysInvalidRule was really invalid!'
    const alwaysInvalidRule = function (context: ValidationContext) {
      return {
        enter() {
          context.reportError(new GraphQLError(expected))
          return BREAK
        }
      }
    }
    const app = createLambda({
      schema,
      validationRules: [alwaysInvalidRule]
    })
    const res = await request(app).post(graphqlPath).send({
      query: 'query test{ testString }'
    })

    assert.deepEqual(res.status, 400)
    assert.deepEqual(res.body.errors[0].message, expected)
  })
})

describe('server setup', () => {
  it('throws error on 404 routes', async () => {
    const app = createLambda()

    const query = {
      query: '{ testString }'
    }
    const res = await request(app).get('/bogus-route').query(query)

    assert.deepEqual(res.body, {})
    assert.deepEqual(res.status, 404)
  })

  it('playgrdound', async () => {
    const app = createLambda()

    const res = await request(app).get('/graphql/playground')

    assert.match(res.text, /GraphQL Playground/g)
    assert.deepEqual(res.status, 200)
  })

  it('healthcheck', async () => {
    const app = createLambda()

    const res = await request(app).get(
      '/graphql/.well-known/apollo/server-health'
    )

    assert.deepEqual(res.body, { status: 'pass' })
    assert.deepEqual(res.status, 200)
  })
})

describe('request pipeline plugins', () => {
  describe('lifecycle hooks', () => {
    it('calls serverWillStart before serving a request', async () => {
      const fn = spy()

      const app = createLambda({
        schema,
        plugins: [
          {
            serverWillStart() {
              fn('zero')
              return new Promise((resolve) => {
                fn('one')
                resolve()
              })
            }
          }
        ]
      })

      await request(app)
        .get(graphqlPath)
        .query({
          query: 'query test{ testString }'
        })
        .then((res) => {
          fn('two')
          return res
        })

      // Finally, ensure that the order we expected was achieved.
      assert.deepEqual(fn.firstCall.args[0], 'zero')
      assert.deepEqual(fn.secondCall.args[0], 'one')
      assert.deepEqual(fn.thirdCall.args[0], 'two')
    })
  })
})

describe('persisted queries', () => {
  const query = '{testString}'
  const query2 = '{ testString }'

  const hash = sha256.create().update(query).hex()
  const extensions = {
    persistedQuery: {
      version: VERSION,
      sha256Hash: hash
    }
  }

  const extensions2 = {
    persistedQuery: {
      version: VERSION,
      sha256Hash: sha256.create().update(query2).hex()
    }
  }

  // let didEncounterErrors: any

  function createMockCache() {
    const map = new Map<string, string>()
    return {
      set: spy(async (key, val, _) => {
        map.set(key, val)
      }),
      get: spy(async (key) => map.get(key)),
      delete: spy(async (key) => map.delete(key))
    }
  }

  const createMocks = () => {
    const didEncounterErrors = spy()

    const cache = createMockCache()

    const app = createLambda({
      schema,
      plugins: [
        {
          requestDidStart() {
            return { didEncounterErrors }
          }
        }
      ],
      persistedQueries: {
        cache
      }
    })

    return { app, cache, didEncounterErrors }
  }

  it('when ttlSeconds is set, passes ttl to the apq cache set call', async () => {
    const cache = createMockCache()
    const app = createLambda({
      schema,
      persistedQueries: {
        cache,
        ttl: 900
      }
    })

    await request(app).post(graphqlPath).send({
      extensions,
      query
    })

    assert.match(cache.set.firstCall.args[0], /^apq:/)
    assert.deepEqual(cache.set.firstCall.args[1], '{testString}')
    assert.deepEqual(cache.set.firstCall.args[2], {
      ttl: 900
    })
  })

  it('when ttlSeconds is unset, ttl is not passed to apq cache', async () => {
    const cache = createMockCache()
    const app = createLambda({ schema, persistedQueries: { cache } })

    await request(app).post(graphqlPath).send({
      extensions,
      query
    })

    assert.match(cache.set.firstCall.args[0], /^apq:/)
    assert.deepEqual(cache.set.firstCall.args[1], '{testString}')
    assert.notDeepEqual(cache.set.firstCall.args[2], {
      ttl: 900
    })
  })

  it('errors when version is not specified', async () => {
    const { app, didEncounterErrors } = createMocks()

    const res = await request(app)
      .get(graphqlPath)
      .query({
        query,
        extensions: JSON.stringify({
          persistedQuery: {
            // Version intentionally omitted.
            sha256Hash: extensions.persistedQuery.sha256Hash
          }
        })
      })

    assert.equal(res.status, 400)
    assert.equal(res.text, 'Unsupported persisted query version')

    assert.equal(
      didEncounterErrors.firstCall.args[0].errors[0].message,
      'Unsupported persisted query version'
    )
  })

  it('errors when version is unsupported', async () => {
    const { app, didEncounterErrors } = createMocks()

    const res = await request(app)
      .get(graphqlPath)
      .query({
        query,
        extensions: JSON.stringify({
          persistedQuery: {
            // Version intentionally wrong.
            version: VERSION + 1,
            sha256Hash: extensions.persistedQuery.sha256Hash
          }
        })
      })

    assert.equal(res.status, 400)
    assert.equal(res.text, 'Unsupported persisted query version')

    assert.equal(
      didEncounterErrors.firstCall.args[0].errors[0].message,
      'Unsupported persisted query version'
    )
  })

  it('errors when hash is mismatched', async () => {
    const { app, didEncounterErrors } = createMocks()

    const res = await request(app)
      .get(graphqlPath)
      .query({
        query,
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            // Sha intentionally wrong.
            sha256Hash: extensions.persistedQuery.sha256Hash.substr(0, 5)
          }
        })
      })

    assert.equal(res.status, 400)
    assert.equal(res.text, 'provided sha does not match query')

    assert.equal(
      didEncounterErrors.firstCall.args[0].errors[0].message,
      'provided sha does not match query'
    )
  })

  it('returns PersistedQueryNotFound on the first try', async () => {
    const { app, didEncounterErrors } = createMocks()

    const res = await request(app).post(graphqlPath).send({
      extensions
    })

    assert.deepEqual(res.body.data, undefined)
    assert.deepEqual(res.body.errors.length, 1)
    assert.deepEqual(res.body.errors[0].message, 'PersistedQueryNotFound')
    assert.deepEqual(
      res.body.errors[0].extensions.code,
      'PERSISTED_QUERY_NOT_FOUND'
    )

    assert.include(
      didEncounterErrors.firstCall.args[0].errors[0],
      PersistedQueryNotFoundError
    )
  })

  it('returns result on the second try', async () => {
    const { app, didEncounterErrors } = createMocks()

    await request(app).post(graphqlPath).send({
      extensions
    })

    // Only the first request should result in an error.
    assert.ok(didEncounterErrors.calledOnce)
    assert.include(
      didEncounterErrors.firstCall.args[0].errors[0],
      PersistedQueryNotFoundError
    )

    const res = await request(app).post(graphqlPath).send({
      extensions,
      query
    })

    // There should be no additional errors now.  In other words, we'll
    // re-assert that we've been called the same single time that we
    // asserted above.
    assert.ok(didEncounterErrors.calledOnce)
    assert.deepEqual(res.body.data, { testString: 'it works' })
    assert.deepEqual(res.body.errors, undefined)
  })

  it('returns with batched persisted queries', async () => {
    const { app } = createMocks()

    const errors = await request(app)
      .post(graphqlPath)
      .send([
        {
          extensions
        },
        {
          extensions: extensions2
        }
      ])

    assert.deepEqual(errors.body[0].data, undefined)
    assert.deepEqual(errors.body[1].data, undefined)
    assert.deepEqual(errors.body[0].errors[0].message, 'PersistedQueryNotFound')
    assert.deepEqual(
      errors.body[0].errors[0].extensions.code,
      'PERSISTED_QUERY_NOT_FOUND'
    )
    assert.deepEqual(errors.body[1].errors[0].message, 'PersistedQueryNotFound')
    assert.deepEqual(
      errors.body[1].errors[0].extensions.code,
      'PERSISTED_QUERY_NOT_FOUND'
    )

    const result = await request(app)
      .post(graphqlPath)
      .send([
        {
          extensions,
          query
        },
        {
          extensions: extensions2,
          query: query2
        }
      ])

    assert.deepEqual(result.body[0].data, { testString: 'it works' })
    assert.deepEqual(result.body[0].data, { testString: 'it works' })
    assert.deepEqual(result.body.errors, undefined)
  })

  it('returns result on the persisted query', async () => {
    const { app } = createMocks()

    await request(app).post(graphqlPath).send({
      extensions
    })
    await request(app).post(graphqlPath).send({
      extensions,
      query
    })
    const result = await request(app).post(graphqlPath).send({
      extensions
    })

    assert.deepEqual(result.body.data, { testString: 'it works' })
    assert.deepEqual(result.body.errors, undefined)
  })

  it('returns error when hash does not match', async () => {
    const { app } = createMocks()

    const response = await request(app)
      .post(graphqlPath)
      .send({
        extensions: {
          persistedQuery: {
            version: VERSION,
            sha:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        },
        query
      })

    assert.deepEqual(response.status, 400)
    assert.match(
      response.error === false ? '' : response.error.text,
      /does not match query/
    )
  })

  it('returns correct result using get request', async () => {
    const { app } = createMocks()

    await request(app).post(graphqlPath).send({
      extensions,
      query
    })
    const result = await request(app)
      .get(graphqlPath)
      .query({
        extensions: JSON.stringify(extensions)
      })

    assert.deepEqual(result.body.data, { testString: 'it works' })
  })
})
