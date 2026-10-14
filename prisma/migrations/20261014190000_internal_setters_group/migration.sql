-- Internal coaching groups (setters, closers, and any later list entry).
-- Additive on the existing production schema (created via `prisma db push`).
-- SendblueGroup.internal defaults false, so current prospect rows stay matched
-- exactly as before. SendblueInternalMessage stores inbound coaching-chat
-- text only; the app never writes prospect group bodies here.
-- internalName distinguishes list entries (`setters`, `closers`) on both tables.

-- AlterTable
ALTER TABLE "SendblueGroup" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SendblueGroup" ADD COLUMN     "internalName" TEXT;

-- CreateTable
CREATE TABLE "SendblueInternalMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderNumber" TEXT NOT NULL,
    "text" TEXT,
    "mediaUrl" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "internalName" TEXT,
    "messageHandle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendblueInternalMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SendblueInternalMessage_messageHandle_key" ON "SendblueInternalMessage"("messageHandle");

-- CreateIndex
CREATE INDEX "SendblueInternalMessage_groupId_sentAt_idx" ON "SendblueInternalMessage"("groupId", "sentAt");

-- CreateIndex
CREATE INDEX "SendblueInternalMessage_internalName_sentAt_idx" ON "SendblueInternalMessage"("internalName", "sentAt");

-- AddForeignKey
ALTER TABLE "SendblueInternalMessage" ADD CONSTRAINT "SendblueInternalMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SendblueGroup"("groupId") ON DELETE CASCADE ON UPDATE CASCADE;
