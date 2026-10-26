#!/usr/bin/env node
/* global console */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredDirectories = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);
const ignoredFiles = new Set(['package-lock.json']);
const ignoredFilePatterns = [/^\.env(?!.*\.example$)/];

const patterns = [
  {
    name: 'Telegram bot token',
    regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    name: 'OpenAI API key',
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: 'Private key block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

async function collectFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      files.push(...(await collectFiles(path.join(directory, entry.name), relativePath)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (ignoredFiles.has(entry.name)) continue;
    if (ignoredFilePatterns.some((pattern) => pattern.test(entry.name))) continue;

    files.push(relativePath);
  }

  return files;
}

const findings = [];

for (const relativePath of await collectFiles(root)) {
  let contents;
  try {
    contents = await readFile(path.join(root, relativePath), 'utf8');
  } catch {
    continue;
  }

  const lines = contents.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (!pattern.regex.test(line)) continue;
      findings.push({
        file: relativePath,
        line: index + 1,
        type: pattern.name,
      });
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.type})`);
  }
  console.error('\nRemove the secret and rotate the credential before committing.');
  process.exit(1);
}

console.log('No potential secrets found in repository files.');
