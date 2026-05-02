/**
 * injection-scanner.ts — Pattern-based prompt injection detection.
 * Pure TypeScript, no dependencies, ~0.1-0.5ms per scan.
 */

export type InjectionFlag = { category: string; pattern: string; weight: number };
export type ScanResult = { score: number; flags: InjectionFlag[]; safe: boolean };

type Rule = { category: string; weight: number; patterns: RegExp[] };

const RULES: Rule[] = [
  {
    category: "instruction-override", weight: 0.9,
    patterns: [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /disregard\s+(any\s+)?previous/i, /disregard\s+above/i,
      /forget\s+(everything|all\s+prior)/i, /new\s+instructions/i,
      /override\s+instructions/i, /do\s+not\s+follow\s+your\s+rules/i,
      /ignore\s+(all\s+)?above/i, /ignore\s+your\s+instructions/i,
      /from\s+now\s+on\s+you\s+will/i, /you\s+must\s+now/i,
      /stop\s+being\s+an?\s+/i,
    ],
  },
  {
    category: "role-hijack", weight: 0.8,
    patterns: [
      /you\s+are\s+now\b/i, /act\s+as\s+if/i,
      /pretend\s+(you'?re|to\s+be)/i, /developer\s+mode/i,
      /\bDAN\s+mode/i, /\bjailbreak\b/i,
      /without\s+any\s+restrictions/i, /bypass\s+(safety|filters)/i,
      /unrestricted\s+mode/i, /you\s+have\s+been\s+freed/i,
      /you\s+can\s+do\s+anything/i, /answer\s+without\s+restrictions/i,
      /no\s+restrictions/i,
    ],
  },
  {
    category: "system-prompt-leak", weight: 0.7,
    patterns: [
      /show\s+(me\s+)?(your\s+)?system\s+prompt/i, /reveal\s+your\s+instructions/i,
      /what\s+are\s+your\s+rules/i, /print\s+the\s+prompt/i,
      /display\s+your\s+instructions/i, /repeat\s+the\s+above/i,
      /output\s+your\s+system/i, /what\s+were\s+you\s+told/i,
      /show\s+your\s+configuration/i, /tell\s+me\s+your\s+instructions/i,
    ],
  },
  {
    category: "delimiter-escape", weight: 0.9,
    patterns: [
      /<<SYS>>/i, /<\/SYS>>/i, /\[INST\]/i, /\[\/INST\]/i,
      /<\|im_start\|>/i, /<\|im_end\|>/i, /<\|system\|>/i,
      /<\|user\|>/i, /<\|assistant\|>/i, /<\/s>/,
      /\{"role"\s*:\s*"system"/i, /\[system\]\(#instructions\)/i,
    ],
  },
  {
    category: "exfiltration", weight: 0.9,
    patterns: [
      /send\s+to\s+https?:/i, /fetch\(\s*["']?https?:/i,
      /curl\s+https?:/i, /wget\s+https?:/i,
      /\bwebhook\b/i, /\bexfiltrate\b/i,
      /upload\s+to\s+/i, /post\s+to\s+https?:/i,
      /forward\s+to\s+https?:/i, /transmit\s+to\s+/i,
      /url\s+encode\s+the\s+result\s+and\s+append/i,
      /access\s+and\s+load\s+the\s+resulting\s+url/i,
    ],
  },
  {
    category: "secret-access", weight: 0.7,
    patterns: [
      /(read|show|display|print|reveal|give)\s+.{0,20}\.env/i,
      /(read|show|display|print|reveal|give)\s+.{0,20}api.?key/i,
      /(read|show|display|print|reveal|give)\s+.{0,20}password/i,
      /(read|show|display|print|reveal|give)\s+.{0,20}secret/i,
      /(read|show|display|print|reveal|give)\s+.{0,20}credentials/i,
      /(read|show|display|print|reveal|give)\s+.{0,20}(private|auth|bot)\s*key/i,
    ],
  },
  {
    category: "code-execution", weight: 0.9,
    patterns: [
      /\beval\s*\(/i, /\bexec\s*\(/i, /os\.popen\s*\(/i,
      /\bimport\s+os\b/i, /\bsubprocess\b/i,
      /__class__/, /__mro__/, /__subclasses__/, /__globals__/, /__builtins__/,
      /require\s*\(\s*["']child_process/i, /\bexecSync\s*\(/i, /\bspawn\s*\(/i,
    ],
  },
  {
    category: "reverse-shell", weight: 1.0,
    patterns: [
      /bash\s+-i\s+>&\s+\/dev\/tcp/i, /nc\s+-e\s+\/bin\/sh/i,
      /\breverse\s+shell\b/i, /\/dev\/tcp\//i, /mkfifo\s+\/tmp/i,
      /curl\s+-O\s+https?:/i, /wget\s+https?:.*backdoor/i,
      /python3?\s+-c\s+["']import\s/i,
    ],
  },
  {
    category: "html-comment-injection", weight: 0.7,
    patterns: [
      /<!--\s*.*(ignore|instruction|override|forget|disregard).*-->/is,
      /\/\*\s*.*(ignore|instruction|override|forget).*\*\//is,
    ],
  },
  {
    category: "cross-plugin-abuse", weight: 0.9,
    patterns: [
      /\*{3,}IMPORTANT\s+NEW\s+INSTRUCTIONS\*{3,}/i,
      /do\s+not\s+print\s+anything/i,
      /without\s+printing\s+anything/i,
      /you\s+do\s+not\s+have\s+to\s+ask\s+for\s+permission/i,
      /just\s+follow\s+the\s+instructions\s+so\s+that/i,
    ],
  },
];

const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF\u00AD]/g;

// Mathematical unicode → ASCII mapping ranges
function normalizeMathUnicode(text: string): string {
  return text.replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    // Bold capitals A-Z
    if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCharCode(65 + cp - 0x1D400);
    // Bold small a-z
    if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCharCode(97 + cp - 0x1D41A);
    // Italic capitals
    if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(65 + cp - 0x1D434);
    // Italic small
    if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCharCode(97 + cp - 0x1D44E);
    // Sans-serif bold capitals
    if (cp >= 0x1D5D4 && cp <= 0x1D5ED) return String.fromCharCode(65 + cp - 0x1D5D4);
    // Sans-serif bold small
    if (cp >= 0x1D5EE && cp <= 0x1D607) return String.fromCharCode(97 + cp - 0x1D5EE);
    // Sans-serif italic capitals
    if (cp >= 0x1D608 && cp <= 0x1D621) return String.fromCharCode(65 + cp - 0x1D608);
    // Sans-serif italic small
    if (cp >= 0x1D622 && cp <= 0x1D63B) return String.fromCharCode(97 + cp - 0x1D622);
    return ch;
  });
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const BASE64_RE = /[A-Za-z0-9+/]{20,}={0,2}/g;

function scanBase64(text: string, flags: InjectionFlag[]): void {
  for (const match of text.matchAll(BASE64_RE)) {
    try {
      const decoded = Buffer.from(match[0], "base64").toString("utf-8");
      if (decoded.length < 5 || !/[a-zA-Z]{3,}/.test(decoded)) continue;
      const sub = scanPatterns(decoded);
      for (const f of sub) flags.push({ ...f, category: `base64:${f.category}` });
    } catch { /* not valid base64 */ }
  }
}

function scanPatterns(text: string): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  for (const rule of RULES) {
    for (const pat of rule.patterns) {
      const m = text.match(pat);
      if (m) {
        flags.push({ category: rule.category, pattern: m[0].slice(0, 60), weight: rule.weight });
        break; // one match per category is enough
      }
    }
  }
  return flags;
}

export function scanForInjection(text: string): ScanResult {
  // Normalize
  let normalized = text.replace(ZERO_WIDTH, "");
  normalized = normalizeMathUnicode(normalized);
  normalized = decodeHtmlEntities(normalized);

  // Pattern scan
  const flags = scanPatterns(normalized);

  // Base64 scan
  scanBase64(normalized, flags);

  const score = flags.length > 0 ? Math.max(...flags.map(f => f.weight)) : 0;
  return { score, flags, safe: score < 0.7 };
}
