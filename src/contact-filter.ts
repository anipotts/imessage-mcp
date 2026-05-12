// Shared contact filtering helpers.

import { z } from "zod";
import { resolveByName } from "./contacts.js";

export const CONTACT_MODE_VALUES = ["auto", "handle", "name"] as const;
export type ContactMode = (typeof CONTACT_MODE_VALUES)[number];
export const contactModeSchema = z.enum(CONTACT_MODE_VALUES)
  .optional()
  .describe("Contact matching mode: auto (default), handle-only, or name-only");

function normalizeLikeQuery(input: string): string {
  return `%${input.trim()}%`;
}

function inferMode(contact: string): ContactMode {
  return /^[+\d]|@/.test(contact.trim()) ? "handle" : "name";
}

export interface BuildContactClauseInput {
  contact?: string;
  contact_mode?: ContactMode;
  alias?: string;
  prefix?: string;
}

export interface BuiltContactClause {
  clause?: string;
  bindings: Record<string, string>;
  mode: ContactMode | null;
}

export function buildContactClause(input: BuildContactClauseInput): BuiltContactClause {
  const contact = input.contact?.trim();
  if (!contact) {
    return { mode: null, bindings: {} };
  }

  const alias = input.alias ?? "h.id";
  const prefix = input.prefix ?? "contact";
  const mode = input.contact_mode ?? inferMode(contact);
  const bindings: Record<string, string> = {};

  const byHandle = (): BuiltContactClause => {
    bindings[prefix] = normalizeLikeQuery(contact);
    return {
      mode: "handle",
      clause: `${alias} LIKE @${prefix}`,
      bindings,
    };
  };

  if (mode === "handle") {
    return byHandle();
  }

  const nameKeys = resolveByName(contact);
  if (nameKeys.length > 0) {
    const clauses: string[] = [];
    nameKeys.forEach((key, i) => {
      const binding = `${prefix}_nk${i}`;
      clauses.push(`${alias} LIKE @${binding}`);
      bindings[binding] = normalizeLikeQuery(key);
    });
    return {
      mode: "name",
      clause: `(${clauses.join(" OR ")})`,
      bindings,
    };
  }

  if (mode === "name") {
    // Name mode with no AddressBook hits falls back to direct LIKE for resilience.
    return byHandle();
  }

  // Auto mode fallback.
  return byHandle();
}

export function applyContactFilter(
  conditions: string[],
  bindings: Record<string, unknown>,
  input: BuildContactClauseInput,
): ContactMode | null {
  const built = buildContactClause(input);
  if (built.clause) {
    conditions.push(built.clause);
    Object.assign(bindings, built.bindings);
  }
  return built.mode;
}

