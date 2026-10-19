import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps corporate typography and colors connected to the shared UI foundation', () => {
 const css=readFileSync(new URL('../src/styles/corporate.css',import.meta.url),'utf8');
 expect(css).toContain("@import '@sapphify/ui/tokens.css'");
 for(const token of ['--sf-font','--sf-ink','--sf-surface','--sf-accent']) expect(css).toContain(`var(${token})`);
 expect(css).not.toMatch(/font-family\s*:\s*["']/);
 expect(css).not.toMatch(/--(?:bg|ink|accent|card)\s*:\s*#/);
});
