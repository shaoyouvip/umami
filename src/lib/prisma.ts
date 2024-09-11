import debug from 'debug';
import { Prisma } from '@prisma/client';
import prisma from '@umami/prisma-client';
import moment from 'moment-timezone';
import { MYSQL, POSTGRESQL, getDatabaseType } from 'lib/db';
import { SESSION_COLUMNS, OPERATORS, DEFAULT_PAGE_SIZE } from './constants';
import { fetchWebsite } from './load';
import { maxDate } from './date';
import { QueryFilters, QueryOptions, PageParams } from './types';
import { filtersToArray } from './params';

const log = debug('umami:prisma');

const MYSQL_DATE_FORMATS = {
  minute: '%Y-%m-%dT%H:%i:00',
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d 00:00:00',
  month: '%Y-%m-01 00:00:00',
  year: '%Y-01-01 00:00:00',
};

const POSTGRESQL_DATE_FORMATS = {
  minute: 'YYYY-MM-DD HH24:MI:00',
  hour: 'YYYY-MM-DD HH24:00:00',
  day: 'YYYY-MM-DD HH24:00:00',
  month: 'YYYY-MM-01 HH24:00:00',
  year: 'YYYY-01-01 HH24:00:00',
};

function getAddIntervalQuery(field: string, interval: string): string {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `${field} + interval '${interval}'`;
  }

  if (db === MYSQL) {
    return `DATE_ADD(${field}, interval ${interval})`;
  }
}

function getDayDiffQuery(field1: string, field2: string): string {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `${field1}::date - ${field2}::date`;
  }

  if (db === MYSQL) {
    return `DATEDIFF(${field1}, ${field2})`;
  }
}

function getCastColumnQuery(field: string, type: string): string {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `${field}::${type}`;
  }

  if (db === MYSQL) {
    return `${field}`;
  }
}

function getDateSQL(field: string, unit: string, timezone?: string): string {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    if (timezone) {
      return `to_char(date_trunc('${unit}', ${field} at time zone '${timezone}'), '${POSTGRESQL_DATE_FORMATS[unit]}')`;
    }
    return `to_char(date_trunc('${unit}', ${field}), '${POSTGRESQL_DATE_FORMATS[unit]}')`;
  }

  if (db === MYSQL) {
    if (timezone) {
      const tz = moment.tz(timezone).format('Z');
      return `date_format(convert_tz(${field},'+00:00','${tz}'), '${MYSQL_DATE_FORMATS[unit]}')`;
    }
    return `date_format(${field}, '${MYSQL_DATE_FORMATS[unit]}')`;
  }
}

function getDateWeeklySQL(field: string, timezone?: string) {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `concat(extract(dow from (${field} at time zone '${timezone}')), ':', to_char((${field} at time zone '${timezone}'), 'HH24'))`;
  }

  if (db === MYSQL) {
    const tz = moment.tz(timezone).format('Z');
    return `date_format(convert_tz(${field},'+00:00','${tz}'), '%w:%H')`;
  }
}

export function getTimestampSQL(field: string) {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `floor(extract(epoch from ${field}))`;
  }

  if (db === MYSQL) {
    return `UNIX_TIMESTAMP(${field})`;
  }
}

function getTimestampDiffSQL(field1: string, field2: string): string {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return `floor(extract(epoch from (${field2} - ${field1})))`;
  }

  if (db === MYSQL) {
    return `timestampdiff(second, ${field1}, ${field2})`;
  }
}

function getSearchSQL(column: string): string {
  const db = getDatabaseType();
  const like = db === POSTGRESQL ? 'ilike' : 'like';

  return `and ${column} ${like} {{search}}`;
}

function mapFilter(column: string, operator: string, name: string, type: string = '') {
  const db = getDatabaseType();
  const like = db === POSTGRESQL ? 'ilike' : 'like';
  const value = `{{${name}${type ? `::${type}` : ''}}}`;

  switch (operator) {
    case OPERATORS.equals:
      return `${column} = ${value}`;
    case OPERATORS.notEquals:
      return `${column} != ${value}`;
    case OPERATORS.contains:
      return `${column} ${like} ${value}`;
    case OPERATORS.doesNotContain:
      return `${column} not ${like} ${value}`;
    default:
      return '';
  }
}

function getFilterQuery(filters: QueryFilters = {}, options: QueryOptions = {}): string {
  const query = filtersToArray(filters, options).reduce((arr, { name, column, operator }) => {
    if (column) {
      arr.push(`and ${mapFilter(column, operator, name)}`);

      if (name === 'referrer') {
        arr.push(
          'and (website_event.referrer_domain != {{websiteDomain}} or website_event.referrer_domain is null)',
        );
      }
    }

    return arr;
  }, []);

  return query.join('\n');
}

function getDateQuery(filters: QueryFilters = {}) {
  const { startDate, endDate } = filters;

  if (startDate) {
    if (endDate) {
      return `and website_event.created_at between {{startDate}} and {{endDate}}`;
    } else {
      return `and website_event.created_at >= {{startDate}}`;
    }
  }

  return '';
}

function getFilterParams(filters: QueryFilters = {}) {
  return filtersToArray(filters).reduce((obj, { name, operator, value }) => {
    obj[name] = [OPERATORS.contains, OPERATORS.doesNotContain].includes(operator)
      ? `%${value}%`
      : value;

    return obj;
  }, {});
}

async function parseFilters(
  websiteId: string,
  filters: QueryFilters = {},
  options: QueryOptions = {},
) {
  const website = await fetchWebsite(websiteId);
  const joinSession = Object.keys(filters).find(key => SESSION_COLUMNS.includes(key));

  return {
    joinSession:
      options?.joinSession || joinSession
        ? `inner join session on website_event.session_id = session.session_id`
        : '',
    filterQuery: getFilterQuery(filters, options),
    dateQuery: getDateQuery(filters),
    params: {
      ...getFilterParams(filters),
      websiteId,
      startDate: maxDate(filters.startDate, website?.resetAt),
      websiteDomain: website.domain,
    },
  };
}

async function rawQuery(sql: string, data: object): Promise<any> {
  if (process.env.LOG_QUERY) {
    log('QUERY:\n', sql);
    log('PARAMETERS:\n', data);
  }

  const db = getDatabaseType();
  const params = [];

  if (db !== POSTGRESQL && db !== MYSQL) {
    return Promise.reject(new Error('Unknown database.'));
  }

  const query = sql?.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (...args) => {
    const [, name, type] = args;

    const value = data[name];

    params.push(value);

    return db === MYSQL ? '?' : `$${params.length}${type ?? ''}`;
  });

  return prisma.rawQuery(query, params);
}

async function pagedQuery<T>(model: string, criteria: T, pageParams: PageParams) {
  const { page = 1, pageSize, orderBy, sortDescending = false } = pageParams || {};
  const size = +pageSize || DEFAULT_PAGE_SIZE;

  const data = await prisma.client[model].findMany({
    ...criteria,
    ...{
      ...(size > 0 && { take: +size, skip: +size * (page - 1) }),
      ...(orderBy && {
        orderBy: [
          {
            [orderBy]: sortDescending ? 'desc' : 'asc',
          },
        ],
      }),
    },
  });

  const count = await prisma.client[model].count({ where: (criteria as any).where });

  return { data, count, page: +page, pageSize: size, orderBy };
}

async function pagedRawQuery(
  query: string,
  queryParams: { [key: string]: any },
  pageParams: PageParams = {},
) {
  const { page = 1, pageSize, orderBy, sortDescending = false } = pageParams;
  const size = +pageSize || DEFAULT_PAGE_SIZE;
  const offset = +size * (page - 1);
  const direction = sortDescending ? 'desc' : 'asc';

  const statements = [
    orderBy && `order by ${orderBy} ${direction}`,
    +size > 0 && `limit ${+size} offset ${offset}`,
  ]
    .filter(n => n)
    .join('\n');

  const count = await rawQuery(`select count(*) as num from (${query}) t`, queryParams).then(
    res => res[0].num,
  );

  const data = await rawQuery(`${query}${statements}`, queryParams);

  return { data, count, page: +page, pageSize: size, orderBy };
}

function getQueryMode(): { mode?: Prisma.QueryMode } {
  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return { mode: 'insensitive' };
  }

  return {};
}

function getSearchParameters(query: string, filters: { [key: string]: any }[]) {
  if (!query) return;

  const mode = getQueryMode();
  const parseFilter = (filter: { [key: string]: any }) => {
    const [[key, value]] = Object.entries(filter);

    return {
      [key]:
        typeof value === 'string'
          ? {
              [value]: query,
              ...mode,
            }
          : parseFilter(value),
    };
  };

  const params = filters.map(filter => parseFilter(filter));

  return {
    AND: {
      OR: params,
    },
  };
}

export default {
  ...prisma,
  getAddIntervalQuery,
  getCastColumnQuery,
  getDayDiffQuery,
  getDateSQL,
  getDateWeeklySQL,
  getFilterQuery,
  getSearchParameters,
  getTimestampDiffSQL,
  getSearchSQL,
  getQueryMode,
  pagedQuery,
  pagedRawQuery,
  parseFilters,
  rawQuery,
};
