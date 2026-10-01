export type DeliveryRoute = 'run' | 'open' | 'copy'

export interface DeliveryHost {
  id: string
  label: string
  route: DeliveryRoute
  available: boolean
  detail: string
}

export interface DeliveryRun {
  key: string
  workspaceId: string
  messageId: string
  revision: string
  hostId: string
  rootPath: string
  state: 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'launch-failed' | 'stopped' | 'interrupted'
  detail: string
  logPath: string
  startedAt: number
  pid?: number
}

export interface DeliveryRequest {
  workspaceId: string
  messageId: string
  hostId: string
}

export interface DeliveryResult {
  detail: string
  run?: DeliveryRun
}
