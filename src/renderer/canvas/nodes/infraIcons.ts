// Brand icon lookup for infra nodes. Registry icon slugs are runtime data
// (user/workspace registry layers can reference any simple-icons slug), so
// resolution must be dynamic - a static import list would silently break for
// custom services and hard-break the build whenever simple-icons renames an
// icon. The package is data-only (SVG path strings); acceptable in a local
// Electron bundle.
import * as si from 'simple-icons'
import awsLambda from '../../assets/infra/aws-lambda.svg'
import awsRds from '../../assets/infra/aws-rds.svg'
import awsDynamoDb from '../../assets/infra/aws-dynamodb.svg'
import awsElastiCache from '../../assets/infra/aws-elasticache.svg'
import awsS3 from '../../assets/infra/aws-s3.svg'
import awsSqs from '../../assets/infra/aws-sqs.svg'
import awsSes from '../../assets/infra/aws-ses.svg'
import awsCloudFront from '../../assets/infra/aws-cloudfront.svg'
import azureAppService from '../../assets/infra/azure-app-service.svg'
import azureFunctions from '../../assets/infra/azure-functions.svg'
import azureCosmosDb from '../../assets/infra/azure-cosmosdb.svg'
import azureServiceBus from '../../assets/infra/azure-service-bus.svg'
import azureBlobStorage from '../../assets/infra/azure-blob-storage.svg'

// simple-icons exports are named `siPostgresql`, `siAmazons3`, ... - slug with
// the first letter of each character run capitalized. Slugs are lowercase
// alphanumerics, so this is just "si" + slug with its first char uppercased.
function exportName(slug: string): string {
  return 'si' + slug.charAt(0).toUpperCase() + slug.slice(1)
}

export interface BrandIcon {
  path: string  // single SVG path, 24x24 viewBox
  title: string
}

const cache = new Map<string, BrandIcon | null>()
const officialServiceIcons: Record<string, string> = {
  'aws/lambda': awsLambda,
  'aws/rds': awsRds,
  'aws/dynamodb': awsDynamoDb,
  'aws/elasticache': awsElastiCache,
  'aws/s3': awsS3,
  'aws/sqs': awsSqs,
  'aws/ses': awsSes,
  'aws/cloudfront': awsCloudFront,
  'azure/app-service': azureAppService,
  'azure/functions': azureFunctions,
  'azure/cosmosdb': azureCosmosDb,
  'azure/service-bus': azureServiceBus,
  'azure/blob-storage': azureBlobStorage,
}

export function officialServiceIcon(serviceId: string): string | undefined {
  return officialServiceIcons[serviceId]
}

/** SVG path for a simple-icons slug, or null if the icon doesn't exist. */
export function brandIcon(slug: string): BrandIcon | null {
  if (!slug) return null
  const hit = cache.get(slug)
  if (hit !== undefined) return hit
  const icon = (si as unknown as Record<string, { path: string; title: string } | undefined>)[exportName(slug)]
  const resolved = icon ? { path: icon.path, title: icon.title } : null
  cache.set(slug, resolved)
  return resolved
}

// Category glyphs - tiny drafting-legend silhouettes drawn as 24x24 paths so
// unbranded/generic nodes still communicate their semantic role.
export const CATEGORY_GLYPHS: Record<string, string> = {
  // cylinder (database)
  database: 'M12 3c-4.4 0-8 1.3-8 3v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3zm0 2c3.9 0 6 1 6 1s-2.1 1-6 1-6-1-6-1 2.1-1 6-1zm6 13c0 .5-2.1 1.5-6 1.5S6 18.5 6 18v-9.2C7.5 9.6 9.6 10 12 10s4.5-.4 6-1.2V18z',
  // cylinder, dashed feel (cache) - reuse cylinder with a lightning bolt
  cache: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z',
  // channel with arrows (queue)
  queue: 'M2 8h14l-3-3 1.4-1.4L20.8 9 14.4 14.4 13 13l3-3H2V8zm20 8H8l3 3-1.4 1.4L3.2 15 9.6 9.6 11 11l-3 3h14v2z',
  // bucket/tray (storage)
  storage: 'M4 4h16v4H4V4zm1 6h14l-1.5 10h-11L5 10zm5 2v6h1.5v-6H10zm3 0v6h1.5v-6H13z',
  // magnifier (search)
  search: 'M10 2a8 8 0 105.3 14l5.3 5.3 1.4-1.4-5.3-5.3A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z',
  // spark/chip (llm)
  llm: 'M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2zm7 12l1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14z',
  // hexagon port (api)
  api: 'M12 2l8.7 5v10L12 22l-8.7-5V7L12 2zm0 2.3L5.3 8.2v7.6L12 19.7l6.7-3.9V8.2L12 4.3zM12 8a4 4 0 110 8 4 4 0 010-8z',
  // shield (auth)
  auth: 'M12 2l8 3v6c0 5.2-3.4 9.4-8 11-4.6-1.6-8-5.8-8-11V5l8-3zm0 2.2L6 6.4v4.6c0 4 2.5 7.4 6 8.8 3.5-1.4 6-4.8 6-8.8V6.4l-6-2.2z',
  // band/platform
  platform: 'M3 16h18v4H3v-4zm2-6l7-6 7 6v4H5v-4zm7-3.4L8.4 9H12h3.6L12 6.6z',
  // globe arcs (cdn)
  cdn: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2c.9 0 2.4 2.7 2.4 8S12.9 20 12 20s-2.4-2.7-2.4-8S11.1 4 12 4zM4.3 9h3.4a22 22 0 000 6H4.3a8 8 0 010-6zm12 0h3.4a8 8 0 010 6h-3.4a22 22 0 000-6z',
  // pulse line (observability)
  observability: 'M2 12h4l2-6 4 12 2-6h8v2h-6.6L13 20 9 8l-1.6 6H2v-2z',
  // envelope (email)
  email: 'M2 5h20v14H2V5zm2 2.4V17h16V7.4l-8 5-8-5zM19.2 7H4.8L12 11.5 19.2 7z',
}
