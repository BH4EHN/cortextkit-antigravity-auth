interface JsonSchemaApi {
  toCodecJson(schema: unknown): unknown
  encodeUnknownSync(schema: unknown): (input: unknown) => unknown
}

interface EffectApi {
  Schema: JsonSchemaApi
}

interface RpcProtocolApi {
  RpcOutput: unknown
}

let encoder: Promise<(input: unknown) => unknown> | undefined

async function loadEncoder(): Promise<(input: unknown) => unknown> {
  const pluginUrl = import.meta.resolve('@opencode-ai/plugin')
  const protocolUrl = import.meta.resolve(
    '@opencode-ai/protocol/groups/rpc',
    pluginUrl,
  )
  const effectUrl = import.meta.resolve('effect', pluginUrl)
  const [effectModule, rpcModule] = await Promise.all([
    import(effectUrl) as Promise<EffectApi>,
    import(protocolUrl) as Promise<RpcProtocolApi>,
  ])
  return effectModule.Schema.encodeUnknownSync(
    effectModule.Schema.toCodecJson(rpcModule.RpcOutput),
  )
}

export function encodeRpcOutput(rawOutput: unknown): Promise<unknown> {
  encoder ??= loadEncoder()
  return encoder.then((encode) => encode({ output: rawOutput }))
}
