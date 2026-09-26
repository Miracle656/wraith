/**
 * Backpressure reporting on subscription sockets (#100).
 *
 * Dropping messages on a saturated socket is what stops one slow consumer from
 * growing server memory without bound — that part already worked. What did not
 * is that the drops were *silent*: a subscriber whose stream lost events could
 * not tell a quiet chain from a hole in its own data, and would treat an
 * incomplete history as complete.
 *
 * These use a fake socket rather than a real one, because the interesting
 * behaviour only happens when `bufferedAmount` is over the threshold and that
 * is not something you can reliably provoke on a loopback connection.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { createBackpressureSender, type SendableSocket } from "../subscriptions";

const OPEN = 1;
const CLOSED = 3;
const NOTICE_MS = 50;

/** A socket whose buffer level the test controls directly. */
function fakeSocket(): SendableSocket & { sent: string[] } {
  return {
    readyState: OPEN,
    bufferedAmount: 0,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

function parseSent(ws: { sent: string[] }): Array<Record<string, any>> {
  return ws.sent.map((s) => JSON.parse(s));
}

describe("createBackpressureSender", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends normally while the socket is keeping up", () => {
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    send({ type: "next", id: "1" });
    send({ type: "next", id: "2" });

    expect(parseSent(ws).map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("drops rather than buffering once the socket is saturated", () => {
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    ws.bufferedAmount = 5_000;
    send({ type: "next", id: "1" });

    expect(ws.sent).toHaveLength(0);
  });

  it("tells the client how many messages it missed, once the socket drains", () => {
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    ws.bufferedAmount = 5_000;
    for (let i = 0; i < 7; i++) send({ type: "next", id: String(i) });
    expect(ws.sent).toHaveLength(0);

    ws.bufferedAmount = 0;
    jest.advanceTimersByTime(NOTICE_MS);

    const [notice] = parseSent(ws);
    expect(notice.type).toBe("backpressure");
    expect(notice.payload.droppedCount).toBe(7);
    expect(notice.payload.message).toMatch(/Re-query the REST API/);
  });

  it("collapses a burst of drops into one notice, not one per message", () => {
    // A notice per dropped message would add to the congestion it is reporting,
    // on a socket that by definition cannot take more traffic.
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    ws.bufferedAmount = 5_000;
    for (let i = 0; i < 200; i++) send({ type: "next", id: String(i) });

    ws.bufferedAmount = 0;
    jest.advanceTimersByTime(NOTICE_MS);

    expect(ws.sent).toHaveLength(1);
    expect(parseSent(ws)[0].payload.droppedCount).toBe(200);
  });

  it("waits instead of sending a notice into a still-saturated socket", () => {
    // The notice would itself be dropped, and the client would never learn.
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    ws.bufferedAmount = 5_000;
    send({ type: "next", id: "1" });

    jest.advanceTimersByTime(NOTICE_MS);
    expect(ws.sent).toHaveLength(0);

    ws.bufferedAmount = 0;
    jest.advanceTimersByTime(NOTICE_MS);
    expect(parseSent(ws)[0].payload.droppedCount).toBe(1);
  });

  it("resets the count after reporting, so the next gap is not double-counted", () => {
    const ws = fakeSocket();
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    ws.bufferedAmount = 5_000;
    send({ type: "next", id: "1" });
    ws.bufferedAmount = 0;
    jest.advanceTimersByTime(NOTICE_MS);

    ws.bufferedAmount = 5_000;
    send({ type: "next", id: "2" });
    send({ type: "next", id: "3" });
    ws.bufferedAmount = 0;
    jest.advanceTimersByTime(NOTICE_MS);

    const notices = parseSent(ws);
    expect(notices).toHaveLength(2);
    expect(notices[0].payload.droppedCount).toBe(1);
    expect(notices[1].payload.droppedCount).toBe(2);
  });

  it("sends nothing on a closed socket", () => {
    const ws = fakeSocket();
    ws.readyState = CLOSED;
    const send = createBackpressureSender(ws, { maxBufferedBytes: 100, noticeMs: NOTICE_MS });

    send({ type: "next", id: "1" });
    jest.advanceTimersByTime(NOTICE_MS * 4);

    expect(ws.sent).toHaveLength(0);
  });
});
