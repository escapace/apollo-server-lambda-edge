import {
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
  Context as LambdaContext
} from 'aws-lambda'
import {
  createLogger as bunyanCreateLogger,
  stdSerializers,
  Serializers
} from 'bunyan'
import { omit, pick } from 'lodash'
import { NAME, LOG_LEVEL } from '../constants'

export const createLogger = (options?: {
  serializers?: Serializers
  name?: string
}) =>
  bunyanCreateLogger({
    name: options?.name ?? NAME,
    serializers: {
      err: stdSerializers.err,
      event: (event: CloudFrontRequestEvent) => ({
        config: event.Records[0].cf.config,
        request: pick(event.Records[0].cf.request, [
          'clientIp',
          'headers',
          'method',
          'origin',
          'querystring',
          'uri'
        ])
      }),
      result: (result: CloudFrontResultResponse) => omit(result, ['body']),
      context: (context: LambdaContext) =>
        omit(context, ['callbackWaitsForEmptyEventLoop']),
      ...options?.serializers
    },
    level: LOG_LEVEL
  })
