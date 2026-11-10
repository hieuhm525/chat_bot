import { eq, sql } from 'drizzle-orm';
import { Db } from '../../db/db.module';
import { conversations, messages } from '../../db/schema';

type MessageValues = typeof messages.$inferInsert;

/** Insert one message and keep the conversation counters in the same transaction. */
export async function writeMessage(tx: Db, values: MessageValues) {
  const [row] = await tx.insert(messages).values(values).returning();
  await tx
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + 1`,
      lastMessageAt: values.createdAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, values.conversationId));
  return row;
}
