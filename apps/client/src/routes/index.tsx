import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useDesktopAgent } from "@/features/desktop-agent/use-desktop-agent";
import { DashboardLayout } from "@/features/desktop-agent/dashboard-layout";

export default function Index() {
  const navigate = useNavigate();
  const agent = useDesktopAgent(null);

  useEffect(() => {
    if (agent.activeConversationId && !agent.loading) {
      navigate(`/conversations/${agent.activeConversationId}`, { replace: true });
    }
  }, [agent.activeConversationId, agent.loading, navigate]);

  return <DashboardLayout agent={agent} />;
}
