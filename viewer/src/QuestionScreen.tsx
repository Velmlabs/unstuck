import { useState } from 'preact/hooks';
import type { AskAnswer, QuestionView } from '@velmlabs/unstuck-protocol';
import { CheckIcon, QuestionIcon } from './icons';

/** The slim brand bar with the time left (left out when embedded in the inbox). */
export function BridgeBar({ remaining }: { remaining?: string }) {
  return (
    <header class="bridge-bar">
      <span class="bridge-brand">Unstuck</span>
      {remaining ? (
        <span class="countdown" data-testid="countdown" aria-label={`Time left ${remaining}`}>
          {remaining}
        </span>
      ) : null}
    </header>
  );
}

export interface QuestionScreenProps {
  question?: QuestionView;
  agentName?: string;
  /** Set once the engine says the question was answered (the echo of what it received). */
  answer?: AskAnswer;
  answered?: boolean;
  remaining?: string;
  embed?: boolean;
  onAnswer(a: { choice?: number; text?: string }): void;
}

/** A question from the agent: pick a choice and/or write a reply, then Send answer. */
export function QuestionScreen({ question, agentName, answer, answered, remaining, embed, onAnswer }: QuestionScreenProps) {
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const bar = embed ? null : <BridgeBar remaining={remaining} />;

  if (answered) {
    const echoed = answer?.label ?? answer?.text;
    return (
      <main class="bridge done">
        {bar}
        <div class="bridge-body bridge-ok">
          <span class="bridge-tick" aria-hidden="true">
            <CheckIcon />
          </span>
          <h1>Answer sent</h1>
          <p class="bridge-lede">{echoed ? `“${echoed}”. Your agent has it. You can close this tab.` : 'Your agent has it. You can close this tab.'}</p>
        </div>
      </main>
    );
  }

  const q = question ?? { text: '', allowText: true };
  const typed = text.trim();
  const ready = !sent && (choice !== null || (q.allowText && typed !== ''));
  const submit = (e?: Event) => {
    e?.preventDefault();
    if (!ready) return;
    setSent(true);
    onAnswer(choice !== null ? { choice } : { text: typed });
  };

  return (
    <main class="bridge question">
      {bar}
      <form class="bridge-form" onSubmit={submit}>
        <div class="bridge-body">
          <span class="bridge-kicker">
            <QuestionIcon />
            {agentName ? `${agentName} asks` : 'Your agent asks'}
          </span>
          <h1 class="bridge-quote">{q.text}</h1>
          {q.details ? <p class="bridge-lede bridge-details">{q.details}</p> : null}
          {q.choices?.length ? (
            <div class="bridge-choices" role="group" aria-label="Choices">
              {q.choices.map((label, i) => (
                <button
                  type="button"
                  key={i}
                  class="bridge-choice"
                  aria-pressed={choice === i}
                  disabled={sent}
                  onClick={() => {
                    setChoice(i);
                    setText('');
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {q.allowText ? (
            <div class="bridge-free">
              <label for="bridge-text">{q.choices?.length ? 'Or write a reply' : 'Your answer'}</label>
              <input
                id="bridge-text"
                class="bridge-text"
                maxLength={500}
                value={text}
                disabled={sent}
                autocomplete="off"
                onInput={(e) => {
                  setText((e.target as HTMLInputElement).value);
                  setChoice(null);
                }}
              />
            </div>
          ) : null}
        </div>
        <div class="bridge-foot">
          <button type="submit" class="btn btn-go" disabled={!ready}>
            Send answer
          </button>
        </div>
      </form>
    </main>
  );
}
