import { useCallback, useEffect, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectConfig } from '../../shared/types'
import { describeProgress, readProgress } from '../canvas/architectureProposal'
import { ArchitectureProposalPanel } from '../components/ArchitectureProposalPanel'
import { ProposalReviewCanvas } from '../components/ProposalReviewCanvas'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { useProposalStore } from '../store/architectureProposalStore'
import { useGraphStore } from '../store/graphStore'

interface ProjectReviewScreenProps {
  project: ProjectConfig
  onFinishReview: () => void
  onBack: () => void
}

/**
 * The proposal review is its own workspace around the real AxiomCanvas. Only
 * the scene data and persistence boundary differ: unapproved systems remain in
 * proposal storage until accepted, while rendering and interaction stay the
 * same implementation as the live Floor.
 */
export function ProjectReviewScreen({ project, onFinishReview, onBack }: ProjectReviewScreenProps) {
  const { proposal, loading, error, finalizing, load, finalize } = useProposalStore(useShallow(state => ({
    proposal: state.proposal,
    loading: state.loading,
    error: state.error,
    finalizing: state.finalizing,
    load: state.load,
    finalize: state.finalize,
  })))
  const { systems, files, floorLayouts } = useGraphStore(useShallow(state => ({
    systems: state.systems,
    files: state.files,
    floorLayouts: state.floorLayouts,
  })))

  useEffect(() => { void load(project.id) }, [project.id, load])

  const progress = useMemo(
    () => readProgress(proposal?.systems ?? []),
    [proposal?.systems],
  )
  const proposedFiles = proposal?.memberships.filter(item => item.disposition === 'assign').length ?? 0
  const finishReview = useCallback(async () => {
    try {
      await finalize()
      onFinishReview()
    } catch {
      // The store surfaces the durable failure in the review rail. Staying on
      // this screen is intentional: navigation cannot outrun persistence.
    }
  }, [finalize, onFinishReview])

  return (
    <main className="axiom-onboarding axiom-project-review">
      <WorkbenchTitleBar
        context={`${project.name} / Architecture Review`}
        status={proposal ? describeProgress(progress).toUpperCase() : 'LOADING PROPOSAL'}
        statusTone={proposal ? (progress.settled ? 'ready' : 'busy') : 'busy'}
      />

      <div className="axiom-review__workspace axiom-review__workspace--proposal">
        <section className="axiom-review__panel axiom-review__panel--proposal" aria-labelledby="review-title">
          <header className="axiom-review__heading axiom-review__heading--proposal">
            <button className="axiom-onboarding__back" onClick={onBack} aria-label="Back to agent connection">
              <span aria-hidden="true">←</span>
              Agent connection
            </button>
            <div className="axiom-onboarding__step">STEP 04 / REVIEW THE MAP</div>
            <h1 id="review-title">Review the architecture your agent found</h1>
            <p>
              This is the proposed system tree-not the current file-only Floor. Approve the boundaries
              that fit, or send one back with a reason. Nothing becomes canonical until you approve it.
            </p>
          </header>

          {proposal ? (
            <>
              <dl className="axiom-review__metrics" aria-label="Proposal summary">
                <ReviewMetric label="Systems" value={String(progress.total)} />
                <ReviewMetric label="Files placed" value={String(proposedFiles)} />
                <ReviewMetric
                  label="Left to review"
                  value={String(progress.pending)}
                  tone={progress.pending > 0 ? 'attention' : 'complete'}
                />
              </dl>

              {(proposal.rationale || proposal.evidenceSummary) && (
                <section className="axiom-review__brief" aria-label="Agent mapping brief">
                  {proposal.rationale && <p><strong>Why this structure</strong>{proposal.rationale}</p>}
                  {proposal.evidenceSummary && <p><strong>Evidence</strong>{proposal.evidenceSummary}</p>}
                </section>
              )}

              <div className="axiom-review__proposal-list">
                <ArchitectureProposalPanel embedded />
              </div>
            </>
          ) : (
            <div className="axiom-review__loading" role="status">
              <strong>{loading ? 'Loading the proposed architecture…' : 'No proposal is available yet.'}</strong>
              <p>{error ?? 'Return to the connection step and ask the agent to map this project.'}</p>
            </div>
          )}

          <footer className="axiom-review__actions axiom-review__actions--proposal">
            <p>
              {progress.pending > 0
                ? 'Done Reviewing accepts the remaining proposed branches and commits this exact map.'
                : 'The review is settled. Commit it as the live canvas to continue.'}
            </p>
            <button
              className="axiom-onboarding__primary"
              onClick={() => void finishReview()}
              disabled={!proposal || finalizing}
            >
              <span>
                <strong>{finalizing ? 'Committing Architecture…' : 'Done Reviewing'}</strong>
                <small>{finalizing
                  ? 'Applying systems, nesting, files, and layout'
                  : 'Make this reviewed map the live canvas'}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>

        <section className="axiom-review__canvas axiom-review__canvas--proposal" aria-label="Proposed architecture canvas">
          {proposal ? (
            <ReactFlowProvider>
              <ProposalReviewCanvas
                proposal={proposal}
                indexedSystems={systems}
                indexedFiles={files}
                indexedLayouts={floorLayouts}
              />
            </ReactFlowProvider>
          ) : (
            <div className="axiom-review__canvas-empty">Waiting for a proposal to draw.</div>
          )}

          <div className="axiom-review__canvas-note">
            <span className="axiom-review__canvas-signal" aria-hidden="true" />
            <div>
              <strong>PROPOSED SYSTEM FLOOR</strong>
              <p>The same nesting and tidy layout engine as the live Floor, without committing unapproved systems.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function ReviewMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'attention' | 'complete'
}) {
  return (
    <div className={`axiom-review__metric axiom-review__metric--${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
