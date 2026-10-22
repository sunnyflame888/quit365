import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = new Set(
  [
    ...execFileSync('git', ['ls-files', '-z']).toString().split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'])
      .toString()
      .split('\0')
  ].filter(Boolean)
);
const leaked = [];
for (const file of files) {
  if (
    /(^|\/)(\.dev\.vars|\.env)(\.|$)|(^|\/)\.wrangler\/|quit365-(backup|encrypted|logs)-.*\.(json|csv)$/.test(
      file
    )
  ) {
    leaked.push(file);
    continue;
  }
  if (/\.(png|zip|heic)$/i.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text
    )
  )
    leaked.push(file);
}
if (leaked.length) {
  console.error('Possible private files/credentials (contents withheld): ' + leaked.join(', '));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${files.size} tracked/nonignored files checked for known credential patterns and private export names. This is not proof of absence of every secret format.`
  );
