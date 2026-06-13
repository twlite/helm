import { useParams } from "react-router";
import { useDesktopAgent } from "@/features/desktop-agent/use-desktop-agent";
import { DashboardLayout } from "@/features/desktop-agent/dashboard-layout";

export default function ConversationRoute() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const agent = useDesktopAgent(conversationId ?? null);
  return <DashboardLayout agent={agent} />;
}
