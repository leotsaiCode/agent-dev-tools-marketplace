// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by leotsaiCode, 2026: settings-based rm allowlist; rewritten in TypeScript.
//
// Drawing the report in a Pane or the AbovePrompt band. Pure functions, no `$`.

import type { ElementTable } from "claude-code";
import type { Risk } from "./classify.js";

// ---- Types ----------------------------------------------------------------

/** What the pane shows for one held command. */
export type Report = {
  summary: string;
  lines: string[];
  /** How many lines were cut from `lines`. */
  more?: number;
  note: string;
};

export type Decision = "proceed" | "cancel" | "timeout" | "interrupted" | "error";

/** The call being held. The buttons write `decision`; the hold loop reads it. */
export type Held = {
  command: string;
  risk: Risk;
  report: Report | null;
  decision: Decision | null;
  where: "pane" | "band";
};

// ---- Layout ---------------------------------------------------------------

export function paneRows(report: Report): number {
  return Math.min(24, 9 + report.lines.length + (report.more ? 1 : 0));
}

/** A byte count as `512 B`, `1.5 KB`, `12 MB`. */
export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** `state` is the held call itself: the buttons write its decision. */
export function draw(t: ElementTable, state: Held, report: Report) {
  const { Box, Text, Button } = t;

  const list = report.lines.map((line, i) => Text({ children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ dimColor: true, children: `  + ${report.more} more` }));
  }

  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice: Decision) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };

  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ bold: true, color: "yellow", children: `⚠ Blast Radius · ${state.risk.label}` }),
      Text({
        wrap: "truncate-end",
        children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })],
      }),
      Text({
        children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })],
      }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          // Cancel has the focus, so Enter refuses the command rather than running it.
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ dimColor: true, children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
