import { describe, it, expect } from 'vitest';
import { bridgeBox, fieldBox, hitField, liftOffset } from '../src/fields';

const otp = { x: 100, y: 200, w: 300, h: 40, kind: 'otp' as const };
const email = { x: 100, y: 300, w: 300, h: 40, kind: 'email' as const };

describe('hitField', () => {
  it('finds the field under a page point, edges included, and null elsewhere', () => {
    expect(hitField([otp, email], { x: 150, y: 220 })).toBe(otp);
    expect(hitField([otp, email], { x: 100, y: 200 })).toBe(otp);
    expect(hitField([otp, email], { x: 400, y: 340 })).toBe(email);
    expect(hitField([otp, email], { x: 99, y: 220 })).toBe(null);
    expect(hitField([], { x: 150, y: 220 })).toBe(null);
  });
});

describe('bridgeBox', () => {
  const canvas = { left: 0, top: 50, width: 640, height: 360 }; // page 1280×720 → scale 0.5, no letterbox
  const page = { width: 1280, height: 720 };
  it('maps a field from page pixels to CSS pixels over the mirror', () => {
    expect(bridgeBox(otp, canvas, page)).toEqual({ left: 50, top: 150, width: 150, height: 32 });
  });
  it('keeps at least 44×32 so iOS treats it as a real input', () => {
    expect(bridgeBox({ x: 0, y: 0, w: 20, h: 10, kind: 'text' }, canvas, page)).toEqual({ left: 0, top: 50, width: 44, height: 32 });
  });
  it('follows the letterbox when the page is narrower than the mirror', () => {
    const tall = { left: 0, top: 0, width: 640, height: 720 }; // page 1280×720 fits 640×360, centred: 180 px bands
    expect(bridgeBox(otp, tall, page)).toEqual({ left: 50, top: 280, width: 150, height: 32 });
  });
  it('without a field, sits over the bottom strip of the mirror', () => {
    expect(bridgeBox(null, canvas, page)).toEqual({ left: 0, top: 50 + 360 - 44, width: 640, height: 44 });
  });
});

describe('liftOffset', () => {
  it('is 0 while the box is above the keyboard, and lifts it just above the keyboard otherwise', () => {
    expect(liftOffset({ top: 100, height: 40 }, 500, 60)).toBe(0);
    expect(liftOffset({ top: 450, height: 40 }, 400, 60)).toBe(60 + 450 + 40 - (400 - 12));
    expect(liftOffset({ top: 0, height: 40 }, 0, 0)).toBe(0); // no viewport information: leave it
  });
});

describe('fieldBox (the outline)', () => {
  const canvas = { left: 0, top: 50, width: 640, height: 360 };
  const page = { width: 1280, height: 720 };
  it('is the field exactly, with no minimum size (a 44×52 code box on a half-size mirror is 22×26)', () => {
    expect(fieldBox({ x: 40, y: 200, w: 44, h: 52, kind: 'numeric' }, canvas, page)).toEqual({ left: 20, top: 150, width: 22, height: 26 });
  });
  it('matches the typing box for a field that is already large enough', () => {
    expect(fieldBox(otp, canvas, page)).toEqual({ left: 50, top: 150, width: 150, height: 20 });
    expect(bridgeBox(otp, canvas, page)).toEqual({ left: 50, top: 150, width: 150, height: 32 });
  });
});
