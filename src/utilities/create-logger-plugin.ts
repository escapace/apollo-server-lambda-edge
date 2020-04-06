/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import type Logger from 'bunyan'
import { createLogger } from './create-logger'

import {
  ApolloServerPlugin,
  GraphQLRequestContext
} from 'apollo-server-plugin-base'
import { includes, isString } from 'lodash'
import { PRODUCTION } from '../constants'
import { DeepPartial } from '../types'

const lens = (context: DeepPartial<GraphQLRequestContext>, log: Logger) => {
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
      ...(PRODUCTION ? {} : { errors: context.response?.errors })
    },
    errors: context.errors,
    metrics: context.metrics,
    queryHash: context.queryHash
  }
  log[hasErrors ? 'error' : 'info']({ graphql }, 'GraphQL Query')
}

export const createLoggerPlugin = (
  logger: Logger = createLogger()
): ApolloServerPlugin => ({
  requestDidStart() {
    return {
      willSendResponse(context) {
        lens(context, logger)
      }
    }
  }
})
