import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, primaryKey, index, check, foreignKey } from 'drizzle-orm/sqlite-core';

export const games = sqliteTable('games', {
  id: text('id').primaryKey(), name: text('name').notNull(),
  saveSlots: integer('save_slots').notNull().default(5),
}, t => [check('slots_range', sql`${t.saveSlots} BETWEEN 1 AND 20`)]);

export const boards = sqliteTable('leaderboards', {
  gameId: text('game_id').notNull().references(() => games.id),
  id: text('id').notNull(), name: text('name').notNull(),
  direction: text('direction', { enum: ['desc', 'asc'] }).notNull(),
  scoreType: text('score_type', { enum: ['integer', 'number'] }).notNull(),
  minScore: real('min_score').notNull(), maxScore: real('max_score').notNull(),
}, t => [primaryKey({ columns: [t.gameId, t.id] }),
  check('direction_valid', sql`${t.direction} IN ('asc','desc')`),
  check('score_type_valid', sql`${t.scoreType} IN ('integer','number')`),
  check('score_range', sql`${t.minScore} <= ${t.maxScore} AND ${t.minScore} >= -9007199254740991 AND ${t.maxScore} <= 9007199254740991`)]);

export const saves = sqliteTable('saves', {
  userId: text('user_id').notNull(), gameId: text('game_id').notNull().references(() => games.id),
  slot: integer('slot').notNull(), data: text('data', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
}, t => [primaryKey({ columns: [t.userId, t.gameId, t.slot] }),
  check('slot_valid', sql`${t.slot} BETWEEN 0 AND 19`),
  check('save_json', sql`json_valid(${t.data}) AND length(CAST(${t.data} AS BLOB)) <= 65536`)]);

export const scores = sqliteTable('scores', {
  userId: text('user_id').notNull(), gameId: text('game_id').notNull(),
  boardId: text('board_id').notNull(), score: real('score').notNull(),
  achievedAt: integer('achieved_at').notNull(),
}, t => [primaryKey({ columns: [t.gameId, t.boardId, t.userId] }),
  foreignKey({ columns: [t.gameId, t.boardId], foreignColumns: [boards.gameId, boards.id] }),
  index('scores_rank_asc').on(t.gameId, t.boardId, t.score, t.userId),
  index('scores_rank_desc').on(t.gameId, t.boardId, sql`${t.score} DESC`, t.userId),
  index('scores_user').on(t.userId),
  check('score_safe', sql`${t.score} BETWEEN -9007199254740991 AND 9007199254740991`)]);
