// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "@pome-sh/shared-types";

export type PageOptions = { page?: number; per_page?: number; perPage?: number };
export type MutatingOptions = { actor?: string };
export type FileChange = { path: string; content: string; delete?: boolean };

// Mutation handlers receive an optional callback that yields the state_delta
// captured around the underlying SQLite write. The default (no callback) is the
// pre-FDRS-320 shape — domain tests and tools.ts ignore the delta channel.
export type StateDeltaCallback = (delta: StateDelta) => void;
