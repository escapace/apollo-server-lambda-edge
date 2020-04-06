declare namespace NodeJS {
  interface Global {
    LAMBDA_REFERENCES: { [key: string]: unknown } | undefined
  }
}
