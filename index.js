import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_REQUEST_COUNT = 100;
const DEFAULT_CONCURRENCY = 5;

const USAGE = 'npm start -- https://example.com/large.jpg --requests 100 --concurrency 5';

const KILOBIT = 1024;
const MEGABIT = 1024 * 1024;

const WRITE_OUT = [
  'size:%{size_download}',
  'wait:%{time_starttransfer}',
  'total:%{time_total}',
].join('\n');

function parsePositiveInteger(raw, label) {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${label} должно быть целым числом больше нуля`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} слишком большое`);
  }

  return value;
}

function parseAddress(raw) {
  if (!raw) {
    throw new Error(`Укажите адрес: ${USAGE}`);
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Некорректный адрес: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Нужен http или https: ${raw}`);
  }

  return url;
}

function parseOptions(argv) {
  let values;
  let positionals;

  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        requests: { type: 'string' },
        concurrency: { type: 'string' },
      },
    });

    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    throw new Error(`Некорректные аргументы. Пример: ${USAGE}`);
  }

  if (positionals.length > 1) {
    throw new Error('Адрес передаётся один раз. Число запросов и параллельность задаются через --requests и --concurrency');
  }

  const url = parseAddress(positionals[0]);
  const requests = values.requests === undefined
    ? DEFAULT_REQUEST_COUNT
    : parsePositiveInteger(values.requests, '--requests');
  const concurrency = values.concurrency === undefined
    ? DEFAULT_CONCURRENCY
    : parsePositiveInteger(values.concurrency, '--concurrency');

  return { url, requests, concurrency };
}

function withCacheBust(url, index) {
  const next = new URL(url);
  const token = `${Date.now()}-${index}-${randomBytes(4).toString('hex')}`;

  next.searchParams.set('cb', token);

  return next;
}

function parseCurl(stdout) {
  const fields = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(':');

        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  const size = Number(fields.size);
  const wait = Number(fields.wait);
  const total = Number(fields.total);

  if (!Number.isFinite(size) || !Number.isFinite(wait) || !Number.isFinite(total)) {
    throw new Error('curl вернул неполный ответ');
  }

  const transfer = total - wait;

  if (transfer <= 0) {
    throw new Error('Время передачи нулевое, скорость посчитать нельзя');
  }

  return {
    size,
    transfer,
    bitsPerSecond: (size * 8) / transfer,
  };
}

function requestError(error, url) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : '';
  const detail = typeof stderr === 'string' ? stderr.trim() : '';

  if (detail) {
    return new Error(detail);
  }

  if (error && typeof error === 'object' && error.code === 'ENOENT') {
    return new Error('Не найден curl');
  }

  return new Error(`Запрос не удался: ${url.href}`);
}

async function download(url) {
  let stdout;

  try {
    const result = await execFileAsync(
      'curl',
      [
        '--fail',
        '-s',
        '-S',
        '-L',
        '-o',
        '/dev/null',
        '-w',
        WRITE_OUT,
        '--url',
        url.href,
      ],
      { encoding: 'utf8' },
    );

    stdout = result.stdout;
  } catch (error) {
    throw requestError(error, url);
  }

  return parseCurl(stdout);
}

async function mapPool(count, limit, worker) {
  const results = new Array(count);
  let next = 0;
  let failure = null;

  async function run() {
    while (next < count && failure === null) {
      const index = next;
      next += 1;

      try {
        results[index] = await worker(index);
      } catch (error) {
        failure ??= error;

        return;
      }
    }
  }

  const workers = Math.min(limit, count);

  await Promise.all(Array.from({ length: workers }, () => run()));

  if (failure) {
    throw failure;
  }

  return results;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

function formatRate(bitsPerSecond) {
  if (bitsPerSecond >= MEGABIT) {
    return `${(bitsPerSecond / MEGABIT).toFixed(2)} Мбит/с`;
  }

  if (bitsPerSecond >= KILOBIT) {
    return `${(bitsPerSecond / KILOBIT).toFixed(2)} Кбит/с`;
  }

  return `${bitsPerSecond.toFixed(2)} бит/с`;
}

async function main() {
  const { url, requests, concurrency } = parseOptions(process.argv.slice(2));

  const samples = await mapPool(requests, concurrency, (index) => {
    return download(withCacheBust(url, index));
  });

  const speed = median(samples.map((sample) => sample.bitsPerSecond));
  const transfer = median(samples.map((sample) => sample.transfer));
  const volume = samples.reduce((sum, sample) => sum + sample.size, 0);

  console.log(`Медиана: ${formatRate(speed)}`);
  console.log(`Объём: ${volume} байт`);
  console.log(`Медианное время передачи: ${transfer.toFixed(3)} с`);

  if (transfer < 1) {
    console.log('Предупреждение: передача короче секунды, замер ближе к задержке, чем к ширине канала.');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
