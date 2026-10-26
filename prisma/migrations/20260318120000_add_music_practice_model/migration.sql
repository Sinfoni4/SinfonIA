-- CreateTable
CREATE TABLE "music_practice" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "music_practice_pkey" PRIMARY KEY ("id")
);
