"use client";

import { useMemo } from "react";

const keywords = new Set([
  "SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE",
  "CREATE","TABLE","VIEW","INDEX","SEQUENCE","SCHEMA","EXTENSION","TYPE",
  "ENUM","AS","IF","NOT","EXISTS","PRIMARY","KEY","FOREIGN","REFERENCES",
  "ON","CONFLICT","DO","NOTHING","UPDATE","EXCLUDED","ALTER","ADD","CONSTRAINT",
  "ENABLE","ROW","LEVEL","SECURITY","POLICY","FOR","USING","WITH","CHECK",
  "BEGIN","COMMIT","ROLLBACK","TRUNCATE","RESTART","IDENTITY","CASCADE",
  "NULL","TRUE","FALSE","DEFAULT","OR","AND","REPLACE","FUNCTION","TRIGGER",
  "LIMIT","OFFSET","ORDER","BY","GROUP","JOIN","LEFT","RIGHT","INNER",
  "RETURNING","UNIQUE","INHERITS","TO","GRANT","REVOKE","AFTER","BEFORE","EACH",
]);

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlight(sql: string): string {
  const tokens: string[] = [];
  const re = /(--[^\n]*)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const [raw, comment, single, dquote, num, word, other] = m;
    if (comment) tokens.push(`<span style="color:#64748b;font-style:italic">${escapeHtml(comment)}</span>`);
    else if (single) tokens.push(`<span style="color:#fca5a5">${escapeHtml(single)}</span>`);
    else if (dquote) tokens.push(`<span style="color:#93c5fd">${escapeHtml(dquote)}</span>`);
    else if (num) tokens.push(`<span style="color:#fcd34d">${escapeHtml(num)}</span>`);
    else if (word) {
      if (keywords.has(word.toUpperCase())) {
        tokens.push(`<span style="color:#34d399;font-weight:600">${escapeHtml(word)}</span>`);
      } else {
        tokens.push(`<span style="color:#cbd5e1">${escapeHtml(word)}</span>`);
      }
    } else tokens.push(escapeHtml(other ?? raw));
  }
  return tokens.join("");
}

export function SqlPreview({ sql }: { sql: string }) {
  const html = useMemo(() => highlight(sql), [sql]);
  return (
    <pre
      className="sm-code"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
