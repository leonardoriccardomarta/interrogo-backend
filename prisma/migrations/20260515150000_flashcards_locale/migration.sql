-- AlterTable
ALTER TABLE "interrogo_sessions" ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'it';

-- CreateTable
CREATE TABLE IF NOT EXISTS "flashcard_decks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceFile" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'it',
    "cardCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flashcard_decks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "flashcards" (
    "id" TEXT NOT NULL,
    "deckId" TEXT NOT NULL,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "chapter" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 5,
    "timesSeen" INTEGER NOT NULL DEFAULT 0,
    "timesKnown" INTEGER NOT NULL DEFAULT 0,
    "intervalDays" INTEGER NOT NULL DEFAULT 0,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "nextReviewAt" TIMESTAMP(3),
    "lastReviewed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flashcards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "flashcard_decks_userId_idx" ON "flashcard_decks"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "flashcards_deckId_idx" ON "flashcards"("deckId");

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "flashcard_decks" ADD CONSTRAINT "flashcard_decks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "flashcard_decks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
