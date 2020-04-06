/*
eslint-disable @typescript-eslint/require-await,
               @typescript-eslint/no-explicit-any
*/

import LRUCache from 'lru-cache'
import { TestableKeyValueCache } from 'apollo-server-caching'
import sizeof from 'object-sizeof'
import { CACHE_SIZE } from '../constants'

const defaultSizeCalculator = (value: any, key: any): number =>
  // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
  sizeof(key) + sizeof(value)

export class InMemoryLRUCache<V = string> implements TestableKeyValueCache<V> {
  private readonly store: LRUCache<string, V>

  constructor({
    // 64mb total for average entry of 2kb
    references = global.LAMBDA_REFERENCES === undefined
      ? (global.LAMBDA_REFERENCES = {})
      : global.LAMBDA_REFERENCES,
    maxSize = CACHE_SIZE,
    sizeCalculator = defaultSizeCalculator,
    onDispose
  }: {
    references?: { [key: string]: any }
    cache?: {}
    maxSize?: number
    sizeCalculator?: (value: V, key: string) => number
    onDispose?: (key: string, value: V) => void
  } = {}) {
    this.store =
      references?.cache !== undefined
        ? references.cache
        : (references.cache = new LRUCache({
            max: maxSize,
            length: sizeCalculator,
            dispose: onDispose
          }))
  }

  async get(key: string) {
    return this.store.get(key)
  }

  async set(key: string, value: V, options?: { ttl?: number }) {
    const maxAge = options?.ttl === undefined ? undefined : options.ttl * 1000
    this.store.set(key, value, maxAge)
  }

  async delete(key: string) {
    this.store.del(key)
  }

  // Drops all data from the cache. This should only be used by test suites ---
  // production code should never drop all data from an end user cache.
  async flush(): Promise<void> {
    this.store.reset()
  }

  async getTotalSize() {
    return this.store.length
  }
}
