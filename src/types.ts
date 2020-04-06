import { CloudFrontRequestEvent } from 'aws-lambda'
import { Config as ApolloServerConfig } from 'apollo-server-core'

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[P] extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : DeepPartial<T[P]>
}

export interface CreateHandlerOptions {
  cors?: {
    origin?: boolean | string | string[]
    methods?: string | string[]
    allowedHeaders?: string | string[]
    exposedHeaders?: string | string[]
    credentials?: boolean
    maxAge?: number
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onHealthCheck?: (req: CloudFrontRequestEvent) => Promise<any>
}

export interface CloudFrontApolloServerEndpoints {
  graphql?: string
  playground?: string
  healthCheck?: string
}

export interface Config extends ApolloServerConfig {
  endpoints?: CloudFrontApolloServerEndpoints
}
