import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { History, User, Folder, Calendar, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { ptBR, enUS, es } from "date-fns/locale";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AuditLog {
  id: string;
  timestamp: string;
  user_id: string | null;
  organization_id: string;
  project_id: string | null;
  action: string;
  resource_type: string;
  resource_name: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
}

const ACTION_COLORS: Record<string, string> = {
  dataset_uploaded: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  dataset_deleted: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  model_trained: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  prediction_executed: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  segment_exported: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  project_created: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300",
  project_deleted: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  retention_policy_updated: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
  data_retention_cleanup: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

const ITEMS_PER_PAGE = 20;

const AuditLogsTab = () => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { currentOrganization, isSuperAdmin } = useOrganization();

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [userProfiles, setUserProfiles] = useState<Record<string, string>>({});

  const locale = i18n.language === "pt" ? ptBR : i18n.language === "es" ? es : enUS;

  useEffect(() => {
    if (currentOrganization) {
      loadLogs();
    }
  }, [currentOrganization, page, actionFilter]);

  const loadLogs = async () => {
    if (!currentOrganization) return;

    try {
      setIsLoading(true);

      let query = (supabase as any)
        .from("audit_logs")
        .select("*", { count: "exact" })
        .eq("organization_id", currentOrganization.id)
        .order("timestamp", { ascending: false })
        .range(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE - 1);

      if (actionFilter !== "all") {
        query = query.eq("action", actionFilter);
      }

      const { data, error, count } = await query;

      if (error) throw error;

      setLogs(data || []);
      setTotalCount(count || 0);

      // Load user profiles for display
      const userIds = [...new Set((data || []).map((l: AuditLog) => l.user_id).filter(Boolean))] as string[];
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", userIds);

        const profileMap: Record<string, string> = {};
        (profiles || []).forEach((p) => {
          profileMap[p.id] = p.full_name;
        });
        setUserProfiles(profileMap);
      }
    } catch (error) {
      console.error("Error loading audit logs:", error);
      toast({
        title: t("common.error"),
        description: t("lgpd.loadLogsError"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

  const getActionLabel = (action: string) => {
    return t(`lgpd.actions.${action}`, { defaultValue: action.replace(/_/g, " ") });
  };

  const formatTimestamp = (ts: string) => {
    return format(new Date(ts), "dd/MM/yyyy HH:mm:ss", { locale });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {t("lgpd.auditLogs")}
              </CardTitle>
              <CardDescription>
                {t("lgpd.auditLogsDesc", { count: totalCount })}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder={t("lgpd.filterByAction")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("lgpd.allActions")}</SelectItem>
                  <SelectItem value="dataset_uploaded">{t("lgpd.actions.dataset_uploaded")}</SelectItem>
                  <SelectItem value="dataset_deleted">{t("lgpd.actions.dataset_deleted")}</SelectItem>
                  <SelectItem value="model_trained">{t("lgpd.actions.model_trained")}</SelectItem>
                  <SelectItem value="prediction_executed">{t("lgpd.actions.prediction_executed")}</SelectItem>
                  <SelectItem value="segment_exported">{t("lgpd.actions.segment_exported")}</SelectItem>
                  <SelectItem value="project_created">{t("lgpd.actions.project_created")}</SelectItem>
                  <SelectItem value="project_deleted">{t("lgpd.actions.project_deleted")}</SelectItem>
                  <SelectItem value="retention_policy_updated">{t("lgpd.actions.retention_policy_updated")}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={loadLogs} disabled={isLoading}>
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t("lgpd.noLogs")}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[180px]">
                      <Calendar className="w-4 h-4 inline mr-1" />
                      {t("lgpd.timestamp")}
                    </TableHead>
                    <TableHead>
                      <User className="w-4 h-4 inline mr-1" />
                      {t("lgpd.user")}
                    </TableHead>
                    <TableHead>{t("lgpd.action")}</TableHead>
                    <TableHead>{t("lgpd.resource")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("lgpd.ipAddress")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-xs">
                        {formatTimestamp(log.timestamp)}
                      </TableCell>
                      <TableCell>
                        {log.user_id ? (
                          userProfiles[log.user_id] || t("lgpd.unknownUser")
                        ) : (
                          <span className="text-muted-foreground italic">
                            {t("lgpd.systemAction")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={ACTION_COLORS[log.action] || ""}
                        >
                          {getActionLabel(log.action)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Folder className="w-3 h-3 text-muted-foreground" />
                          <span className="text-sm">
                            {log.resource_name || log.resource_type}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {log.ip_address || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    {t("lgpd.showingLogs", {
                      from: page * ITEMS_PER_PAGE + 1,
                      to: Math.min((page + 1) * ITEMS_PER_PAGE, totalCount),
                      total: totalCount,
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AuditLogsTab;
