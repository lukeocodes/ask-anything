CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."chunk_kind" AS ENUM('file', 'section', 'paragraph', 'code');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('active', 'stale', 'archived', 'proposed');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'applied');--> statement-breakpoint
CREATE TYPE "public"."revision_actor" AS ENUM('api', 'source', 'proposal', 'system');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('idle', 'indexing', 'error');--> statement-breakpoint
CREATE TYPE "public"."surface" AS ENUM('api', 'cli', 'mcp', 'backfill', 'warm');--> statement-breakpoint
CREATE TYPE "public"."url_crawl" AS ENUM('page', 'sitemap');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "answer_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_embedding" vector(1024),
	"query_text" text NOT NULL,
	"visibility" "visibility" NOT NULL,
	"answer_text" text NOT NULL,
	"cited_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text NOT NULL,
	"answer_id" uuid,
	"hits" integer DEFAULT 0 NOT NULL,
	"invalidated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_event_id" uuid NOT NULL,
	"text" text NOT NULL,
	"model" text NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decay_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"effective_confidence" real NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"comment" text,
	"surface" "surface",
	"actor_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"ord" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"heading" text,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"kind" "chunk_kind" DEFAULT 'section' NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"body" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"source_id" uuid,
	"status" "knowledge_status" DEFAULT 'active' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"base_confidence" real DEFAULT 1 NOT NULL,
	"decay_rate" real DEFAULT 0.02 NOT NULL,
	"retrieval_count" integer DEFAULT 0 NOT NULL,
	"last_retrieved_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"change_reason" text,
	"created_by" "revision_actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"locator" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"branch" text,
	"include" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"crawl" "url_crawl",
	"schedule" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_env" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" "source_status" DEFAULT 'idle' NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"last_commit" text,
	"last_error" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid,
	"raw_text" text NOT NULL,
	"surface" "surface" NOT NULL,
	"actor_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"embedding" vector(1024),
	"ask_count" integer DEFAULT 0 NOT NULL,
	"first_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"canonical_item_id" uuid
);
--> statement-breakpoint
CREATE TABLE "update_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"proposed_title" text,
	"proposed_summary" text,
	"proposed_body" text,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"approval_ref" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"surface" "surface",
	"actor" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_event_id_question_events_id_fk" FOREIGN KEY ("question_event_id") REFERENCES "public"."question_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decay_events" ADD CONSTRAINT "decay_events_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_parent_id_knowledge_chunks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_events" ADD CONSTRAINT "question_events_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_canonical_item_id_knowledge_items_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_proposals" ADD CONSTRAINT "update_proposals_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_cache_embedding_idx" ON "answer_cache" USING hnsw ("question_embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "answer_cache_visibility_idx" ON "answer_cache" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "answer_cache_invalidated_idx" ON "answer_cache" USING btree ("invalidated");--> statement-breakpoint
CREATE INDEX "answer_cache_answer_idx" ON "answer_cache" USING btree ("answer_id");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "feedback_answer_idx" ON "feedback" USING btree ("answer_id");--> statement-breakpoint
CREATE INDEX "feedback_rating_idx" ON "feedback" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_item_idx" ON "knowledge_chunks" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_parent_idx" ON "knowledge_chunks" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_item_path_uq" ON "knowledge_chunks" USING btree ("item_id","path");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_fts_idx" ON "knowledge_chunks" USING gin (to_tsvector('english', "body"));--> statement-breakpoint
CREATE INDEX "knowledge_items_status_idx" ON "knowledge_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "knowledge_items_visibility_idx" ON "knowledge_items" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "knowledge_items_source_type_idx" ON "knowledge_items" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "knowledge_items_last_verified_idx" ON "knowledge_items" USING btree ("last_verified_at");--> statement-breakpoint
CREATE INDEX "knowledge_items_embedding_idx" ON "knowledge_items" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_revisions_item_rev_uq" ON "knowledge_revisions" USING btree ("item_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_locator_uq" ON "knowledge_sources" USING btree ("locator");--> statement-breakpoint
CREATE INDEX "question_events_question_idx" ON "question_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "questions_embedding_idx" ON "questions" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "questions_ask_count_idx" ON "questions" USING btree ("ask_count");--> statement-breakpoint
CREATE INDEX "update_proposals_status_idx" ON "update_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "update_proposals_item_idx" ON "update_proposals" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "usage_events_kind_idx" ON "usage_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "usage_events_created_idx" ON "usage_events" USING btree ("created_at");