import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const SERVICE_NAME = 'refresh'
const SERVICE_VERSION = process.env.REFRESH_VERSION ?? process.env.npm_package_version ?? '1.0.0'
const TRACE_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces'

let sdk: NodeSDK | null = null

export function startTracing(): { serviceName: string; serviceVersion: string } {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      'service.namespace': 'k2-user',
      'deployment.environment': 'production',
    }),
    traceExporter: new OTLPTraceExporter({
      url: TRACE_ENDPOINT,
    }),
  })
  sdk.start()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdownTracing().finally(() => process.exit(0))
    })
  }

  return { serviceName: SERVICE_NAME, serviceVersion: SERVICE_VERSION }
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown()
  sdk = null
}
