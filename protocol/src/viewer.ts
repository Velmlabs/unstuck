import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AskAnswer } from './result';

export const SessionStatusSchema = Type.Union(
  ['created', 'notifying', 'waiting', 'active', 'resolved', 'answered', 'timed_out', 'cancelled', 'failed'].map((s) => Type.Literal(s)),
);
export type SessionStatus = 'created' | 'notifying' | 'waiting' | 'active' | 'resolved' | 'answered' | 'timed_out' | 'cancelled' | 'failed';

/** control: the person drives the page; approval: confirms a sign-in on their own device; question: answers an ask(). */
export type SessionMode = 'control' | 'approval' | 'question';
export const SessionModeSchema = Type.Union([Type.Literal('control'), Type.Literal('approval'), Type.Literal('question')]);

export interface QuestionView {
  text: string;
  choices?: string[];
  allowText: boolean;
  details?: string;
}
const QuestionViewSchema = Type.Object(
  {
    text: Type.String(),
    choices: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
    allowText: Type.Boolean(),
    details: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const AskAnswerSchema = Type.Object(
  { choice: Type.Optional(Type.Number()), label: Type.Optional(Type.String()), text: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

const Num = Type.Number();
const Lit = <T extends string>(v: T) => Type.Literal(v);

export const ViewerToEngineSchema = Type.Union([
  Type.Object(
    {
      t: Lit('hello'),
      token: Type.String(),
      resumeKey: Type.Optional(Type.String()),
      code: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
      /** The viewer's random value for this connection; engines that announce v: 2 echo it in ready (anti-replay). */
      vn: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{16,64}$' })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      t: Lit('mouse'),
      action: Type.Union([Lit('down'), Lit('up'), Lit('move')]),
      x: Num,
      y: Num,
      button: Type.Union([Lit('left'), Lit('right'), Lit('middle'), Lit('none')]),
      clickCount: Num,
      modifiers: Num,
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Lit('wheel'), x: Num, y: Num, dx: Num, dy: Num }, { additionalProperties: false }),
  Type.Object(
    {
      t: Lit('key'),
      action: Type.Union([Lit('down'), Lit('up')]),
      key: Type.String(),
      code: Type.String(),
      text: Type.Optional(Type.String()),
      modifiers: Num,
    },
    { additionalProperties: false },
  ),
  Type.Object({ t: Lit('text'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ t: Lit('done') }, { additionalProperties: false }),
  Type.Object({ t: Lit('cant_solve'), reason: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
  Type.Object({ t: Lit('ping') }, { additionalProperties: false }),
  /** Approval mode: "I've approved it". */
  Type.Object({ t: Lit('approved') }, { additionalProperties: false }),
  /** Approval mode: "Open the browser instead". */
  Type.Object({ t: Lit('switch_control') }, { additionalProperties: false }),
  /** Question mode: a choice (0-5) and/or typed text. */
  Type.Object(
    { t: Lit('answer'), choice: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })), text: Type.Optional(Type.String({ maxLength: 500 })) },
    { additionalProperties: false },
  ),
  /**
   * Frame credit opt-in, sent only to an engine whose ready says `credit: 1` (older engines refuse unknown messages):
   * from now on the engine sends type-2 frames and keeps at most a few (CREDIT_MAX_IN_FLIGHT in core) unacknowledged.
   */
  Type.Object({ t: Lit('credit'), v: Type.Literal(1) }, { additionalProperties: false }),
  /** This frame (and every earlier one) has been drawn. */
  Type.Object({ t: Lit('ack'), seq: Type.Integer({ minimum: 1, maximum: 0xffffffff }) }, { additionalProperties: false }),
]);
export type ViewerToEngine = Static<typeof ViewerToEngineSchema>;
export type ViewerInput = Extract<ViewerToEngine, { t: 'mouse' | 'wheel' | 'key' | 'text' }>;

export const ViewerErrorCodes = ['token_invalid', 'token_used', 'expired', 'session_closed', 'bad_message', 'code_required', 'code_invalid'] as const;
export type ViewerErrorCode = (typeof ViewerErrorCodes)[number];

/** What kind of field the person can type into, so the viewer can open the matching keyboard (never its value). */
export const FieldKinds = ['text', 'numeric', 'otp', 'email', 'password'] as const;
export type FieldKind = (typeof FieldKinds)[number];
const FieldKindSchema = Type.Union(FieldKinds.map((k) => Lit(k)));
/** A typable field's box in CSS pixels of the streamed viewport (the same space as `mouse` messages). */
export const FieldSchema = Type.Object({ x: Num, y: Num, w: Num, h: Num, kind: FieldKindSchema }, { additionalProperties: false });
export type Field = Static<typeof FieldSchema>;

export const EngineToViewerSchema = Type.Union([
  Type.Object({
    t: Lit('ready'),
    reason: Type.String(),
    site: Type.String(),
    expiresAt: Num,
    resumeKey: Type.String(),
    vn: Type.Optional(Type.String()),
    credit: Type.Optional(Type.Literal(1)),
  }),
  Type.Object({ t: Lit('state'), status: SessionStatusSchema, answer: Type.Optional(AskAnswerSchema) }),
  Type.Object({ t: Lit('error'), code: Type.Union(ViewerErrorCodes.map((c) => Lit(c))), message: Type.String() }),
  Type.Object({ t: Lit('pong') }),
  Type.Object({
    t: Lit('mode'),
    mode: SessionModeSchema,
    reason: Type.String(),
    site: Type.String(),
    agentName: Type.Optional(Type.String()),
    question: Type.Optional(QuestionViewSchema),
  }),
  Type.Object({ t: Lit('fields'), fields: Type.Array(FieldSchema, { maxItems: 30 }) }),
  Type.Object({ t: Lit('focus'), kind: Type.Union([FieldKindSchema, Type.Null()]), field: Type.Optional(FieldSchema) }),
]);
export type EngineToViewer =
  /** `credit: 1`: this engine paces frames by the viewer's acks once the viewer opts in with `{ t: 'credit', v: 1 }`. */
  | { t: 'ready'; reason: string; site: string; expiresAt: number; resumeKey: string; vn?: string; credit?: 1 }
  | { t: 'state'; status: SessionStatus; answer?: AskAnswer }
  | { t: 'error'; code: ViewerErrorCode; message: string }
  | { t: 'pong' }
  /** Sent only for approval and question sessions (older viewers never see it). */
  | { t: 'mode'; mode: SessionMode; reason: string; site: string; agentName?: string; question?: QuestionView }
  | { t: 'fields'; fields: Field[] }
  /** `field`: where the focused field is (engine 0.1.3+), so the viewer can outline it; never its value. */
  | { t: 'focus'; kind: FieldKind | null; field?: Field };

export function parseViewerMessage(raw: string): ViewerToEngine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return Value.Check(ViewerToEngineSchema, v) ? (v as ViewerToEngine) : null;
}

/**
 * How long a human who left the viewer (switched apps to read a code, lost signal) can come back and resume.
 * The engine frees the agent after this; the viewer stops retrying after it.
 */
export const RESUME_WINDOW_MS = 5 * 60_000;
