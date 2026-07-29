import { randomUUID } from 'node:crypto';

export const id = () => randomUUID().slice(0, 8);

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Money is stored to the cent so totals always reconcile. */
export const money = (value) => Math.round(value * 100) / 100;

/** Box–Muller — normally distributed noise reads far more like a real chart than uniform. */
export function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);
export const unauthorized = (message) => new HttpError(401, message);
