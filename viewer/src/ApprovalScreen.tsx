import { useState } from 'preact/hooks';
import type { Ref } from 'preact';
import { cleanLabel } from './alert-link';
import { PhoneIcon } from './icons';
import { BridgeBar } from './QuestionScreen';

export interface ApprovalScreenProps {
  reason: string;
  site: string;
  /** The small canvas App draws the newest frame on (the same draw path as the live view). */
  canvasRef: Ref<HTMLCanvasElement>;
  remaining?: string;
  embed?: boolean;
  /** The engine is checking the page (the prompt went away, or the person said they approved). */
  checking?: boolean;
  onApproved(): void;
  onShowPage(): void;
}

/** "Check your phone": a waiting page. The person approves on their own device; the agent carries on by itself. */
export function ApprovalScreen({ reason, site, canvasRef, remaining, embed, checking: judging, onApproved, onShowPage }: ApprovalScreenProps) {
  const [tapped, setChecking] = useState(false);
  const checking = tapped || !!judging;
  const shownSite = cleanLabel(site, 253);
  return (
    <main class="bridge approval">
      {embed ? null : <BridgeBar remaining={remaining} />}
      <div class="bridge-body">
        <span class="bridge-icon" aria-hidden="true">
          <PhoneIcon />
        </span>
        <h1>{reason}</h1>
        <p class="bridge-lede">Open the prompt on your phone and approve it. Your agent carries on by itself once it goes through.</p>
        {shownSite ? <p class="bridge-site">{shownSite}</p> : null}
        <canvas ref={canvasRef} class="approval-preview" role="img" aria-label="Small preview of the agent's page" />
        <p class="bridge-watch" role="status">
          <i class="pulse" aria-hidden="true" />
          <span>{checking ? 'Checking the page…' : 'Watching the page for your approval'}</span>
        </p>
      </div>
      <div class="bridge-foot">
        <button
          type="button"
          class="btn btn-go"
          onClick={() => {
            setChecking(true);
            onApproved();
          }}
        >
          I've approved it
        </button>
        <button type="button" class="btn btn-ghost" onClick={onShowPage}>
          Show me the page
        </button>
      </div>
    </main>
  );
}
