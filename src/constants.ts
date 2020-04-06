import { LogLevelString } from 'bunyan'
import { includes, isString } from 'lodash'

export const PRODUCTION: boolean = process.env.NODE_ENV === 'production'
export const NAME: string = isString(process.env.LAMBDA_NAME)
  ? process.env.LAMBDA_NAME.toUpperCase()
  : 'apollo-server-lambda-edge'
export const LOG_LEVEL: LogLevelString =
  isString(process.env.LAMBDA_LOG_LEVEL) &&
  includes(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    process.env.LAMBDA_LOG_LEVEL
  )
    ? (process.env.LAMBDA_LOG_LEVEL as LogLevelString)
    : 'info'

export const CACHE_SIZE: number = isString(process.env.LAMBDA_CACHE_SIZE)
  ? parseInt(process.env.LAMBDA_CACHE_SIZE, 10) * 1000000
  : 32000000
