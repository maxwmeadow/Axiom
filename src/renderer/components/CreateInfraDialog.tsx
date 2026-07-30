import { useGraphStore } from '../store/graphStore'
import type { InfraService } from '../../shared/types'
import { InfraPickerDialog } from './InfraPickerDialog'

interface CreateInfraDialogProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Creation adapter for the shared infrastructure catalog. This component owns
 * only the create-node API call; all infrastructure browsing UI and behavior
 * lives in InfraPickerDialog.
 */
export function CreateInfraDialog({ isOpen, onClose }: CreateInfraDialogProps) {
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')

  if (!isOpen) return null

  const createInfra = async (service: InfraService, name: string) => {
    const response = await fetch('http://127.0.0.1:7743/api/infra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        service: service.id,
        name,
        createdBy: 'user',
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    // Canvas updates via the infra:upserted WebSocket patch.
  }

  return (
    <InfraPickerDialog
      mode="create"
      onCreate={createInfra}
      onClose={onClose}
    />
  )
}
