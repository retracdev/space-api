import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, primaryKey, index, check, foreignKey } from 'drizzle-orm/sqlite-core';

export const presence = sqliteTable('presence', {
  site: text('site').notNull(),
  visitorId: text('visitor_id').notNull(),
  displayName: text('display_name').notNull(),
  lastSeen: integer('last_seen').notNull(),
}, t => [primaryKey({ columns: [t.site, t.visitorId] }),
  index('presence_site_last_seen').on(t.site, t.lastSeen),
  index('presence_last_seen').on(t.lastSeen)]);

export const counters = sqliteTable('counters', {
  name: text('name').primaryKey().notNull(),
  count: integer('count').notNull().default(0),
});

export const soundboardNotifications = sqliteTable('soundboard_notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  soundName: text('sound_name').notNull(),
  status: text('status', { enum: ['added', 'denied'] }).notNull(),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  readAt: integer('read_at'),
}, t => [index('soundboard_notifications_user').on(t.userId, t.readAt, t.createdAt, t.id),
  check('soundboard_notification_status_valid', sql`${t.status} IN ('added','denied')`)]);

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

// Reusable image storage metadata. Bytes live in the SPACE_STORAGE R2 bucket.
// `pending` rows are short-lived quota reservations; `deleting` rows are being
// removed from R2. Only `ready` rows are listed or publicly served.
export const storageImages = sqliteTable('storage_images', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  appId: text('app_id').notNull(),
  category: text('category').notNull(),
  objectKey: text('object_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  status: text('status', { enum: ['pending', 'ready', 'deleting'] }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('storage_images_owner').on(t.ownerId, t.category, t.status, t.createdAt),
  index('storage_images_status').on(t.status, t.createdAt),
  check('storage_id_valid', sql`length(${t.id}) = 32 AND ${t.id} NOT GLOB '*[^0-9a-f]*'`),
  check('storage_mime_valid', sql`${t.mimeType} IN ('image/png','image/jpeg','image/webp','image/gif')`),
  check('storage_size_valid', sql`${t.size} BETWEEN 1 AND 2097152`),
  check('storage_dimensions_valid', sql`${t.width} BETWEEN 1 AND 16384 AND ${t.height} BETWEEN 1 AND 16384`),
  check('storage_status_valid', sql`${t.status} IN ('pending','ready','deleting')`)]);
