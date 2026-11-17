export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}
export interface RpcError {
  code: string;
  message: string;
}
export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}
export interface RpcNotification {
  method: string;
  params?: unknown;
}

import type { AlertKind, CheckKind } from './guard';

export const PROTOCOL_VERSION = 1;
/** Additions within major 1. An engine that sends no minor is minor 0 and has no capabilities. */
export const PROTOCOL_MINOR = 2;
export type EngineCapability = 'guard' | 'paintCheck' | 'ask';

/** Method names on the SDK <-> engine JSON-lines channel. */
export const Methods = {
  // SDK -> engine requests
  hello: 'engine.hello',
  takeover: 'takeover',
  ask: 'ask',
  shutdown: 'shutdown',
  guardOpen: 'guard.open',
  guardBefore: 'guard.before',
  guardAfter: 'guard.after',
  guardCheck: 'guard.check',
  guardAskHuman: 'guard.askHuman',
  guardSession: 'guard.getSession',
  guardRemember: 'guard.rememberSite',
  guardForget: 'guard.forgetSite',
  guardForgetAll: 'guard.forgetAll',
  guardClose: 'guard.close',
  paintCheck: 'browser.paintCheck',
  // engine -> SDK requests
  cdpSend: 'cdp.send',
  cdpSubscribe: 'cdp.subscribe',
  /** Open a new tab in the same browser as pageId (the paint probe); answers the new tab's pageId. */
  pageCreate: 'page.create',
  pageClose: 'page.close',
  // SDK -> engine notifications
  cdpEvent: 'cdp.event',
  cdpClosed: 'cdp.closed',
  /** The SDK attached a popup the page opened; the engine may now use popupPageId. */
  pagePopup: 'page.popup',
  // engine -> SDK notifications
  takeoverLink: 'takeover.link',
  /** Like takeover.link, for an ask. */
  askLink: 'ask.link',
  /** A guard's rescue started (active: true) or ended; the SDK follows popups only while one is active. */
  guardRescue: 'guard.rescue',
} as const;

export interface HelloParams {
  sdk: 'ts' | 'py';
  sdkVersion: string;
  protocolVersion: number;
  protocolMinor?: number;
}
export interface HelloResult {
  engineVersion: string;
  protocolVersion: number;
  protocolMinor?: number;
  capabilities?: EngineCapability[];
}
export interface TakeoverParams {
  pageId: string;
  reason: string;
  timeoutS?: number;
  site?: string;
  /** Ask the human for a 6-digit code delivered with the link (relay spec §5.8). */
  requireCode?: boolean;
  /** Sites besides the page's own the human may navigate to, e.g. ["accounts.google.com"] (page lock). */
  allowedSites?: string[];
  /**
   * Send this takeover to the user's paired phones (Unstuck Cloud); undefined means yes, false skips it. 'required' fails
   * the takeover with `alert_failed` when Unstuck Cloud can't accept the link for at least one paired phone; without
   * Unstuck Cloud the engine answers the request with error code `config_error`.
   */
  alerts?: boolean | 'required';
  /** `approval`: the person only confirms a sign-in on their own device; no remote control. Default `control`. */
  mode?: 'control' | 'approval';
  /** The kind the alert carries; default `other`. */
  kind?: AlertKind;
}
export interface AskParams {
  question: string;
  choices?: string[];
  allowText?: boolean;
  /** Keep the question and answer from Unstuck Cloud (default true). */
  private?: boolean;
  details?: string;
  timeoutS?: number;
  alerts?: boolean | 'required';
}
export interface CdpSendParams {
  pageId: string;
  method: string;
  params?: object;
}
export interface CdpSubscribeParams {
  pageId: string;
  events: string[];
}
export interface CdpEventParams {
  pageId: string;
  method: string;
  params: unknown;
}
export interface CdpClosedParams {
  pageId: string;
  reason: string;
}
export interface PagePopupParams {
  pageId: string;
  popupPageId: string;
}
export interface TakeoverLinkParams {
  sessionId: string;
  pageId: string;
  url: string;
  reason: string;
  expiresAt: number;
  /** The 6-digit code, when the takeover requires one. Never part of the URL. */
  code?: string;
  kind?: AlertKind;
}
export interface AskLinkParams {
  sessionId: string;
  url: string;
  reason: string;
  expiresAt: number;
  code?: string;
}

export interface GuardOpenParams {
  pageId: string;
  /** Identifies the browser the page lives in; the paint check runs once per key. */
  browserKey: string;
  profile?: string;
  rescue?: CheckKind[];
  remember?: boolean;
  maxRescuesPerHour?: number;
  timeoutS?: number;
  allowedSites?: string[];
  requireCode?: boolean;
  alerts?: boolean | 'required';
  approvalTimeoutS?: number;
}
export interface GuardOpenResult {
  guardId: string;
}
export interface GuardBeforeParams {
  guardId: string;
  url?: string;
}
export interface GuardAfterParams {
  guardId: string;
  requestedUrl?: string;
  mayNavigate?: boolean;
}
export interface GuardAskParams {
  guardId: string;
  reason: string;
}
export interface GuardSiteParams {
  guardId: string;
  domain?: string;
}
export interface PaintCheckParams {
  pageId: string;
  browserKey: string;
}
export interface PaintCheckResult {
  paint: boolean | 'unknown';
}
export interface PageCreateParams {
  pageId: string;
}
export interface PageCreateResult {
  pageId: string;
}
export interface PageCloseParams {
  pageId: string;
}
export interface GuardRescueParams {
  guardId: string;
  pageId: string;
  active: boolean;
}
