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

export const PROTOCOL_VERSION = 1;

/** Method names on the SDK <-> engine JSON-lines channel. */
export const Methods = {
  // SDK -> engine requests
  hello: 'engine.hello',
  takeover: 'takeover',
  shutdown: 'shutdown',
  // engine -> SDK requests
  cdpSend: 'cdp.send',
  cdpSubscribe: 'cdp.subscribe',
  // SDK -> engine notifications
  cdpEvent: 'cdp.event',
  cdpClosed: 'cdp.closed',
  /** The SDK attached a popup the page opened; the engine may now use popupPageId. */
  pagePopup: 'page.popup',
  // engine -> SDK notifications
  takeoverLink: 'takeover.link',
} as const;

export interface HelloParams {
  sdk: 'ts' | 'py';
  sdkVersion: string;
  protocolVersion: number;
}
export interface HelloResult {
  engineVersion: string;
  protocolVersion: number;
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
  /** Send this takeover to the user's paired phones (Unstuck Cloud); undefined means yes, false skips it. */
  alerts?: boolean;
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
}
