import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  BarChart3, Building2, FolderKanban, Brain, Target, Download, 
  RefreshCw, AlertTriangle, Clock, Users, Zap
} from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import Header from "@/components/layout/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminAnalytics } from "@/components/admin-analytics/hooks/useAdminAnalytics";
import { DateRange, OrganizationUsage } from "@/components/admin-analytics/types";
import { ExportAnalyticsPDFModal } from "@/components/admin-analytics/ExportAnalyticsPDFModal";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const AdminAnalytics = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isSuperAdmin } = useOrganization();
  const [showExportModal, setShowExportModal] = useState(false);

  const {
    dateRange, setDateRange,
    isLoading, isLoadingTTV,
    globalKPIs, healthMetrics, organizationUsage, dailyTrend,
    timeToValue,
    refresh,
  } = useAdminAnalytics();

  if (!isSuperAdmin) {
    navigate("/dashboard");
    return null;
  }

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  };

  const formatHours = (hours: number | null) => {
    if (!hours) return "-";
    if (hours < 1) return `${Math.round(hours * 60)}min`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  };

  return (
    <div className="min-h-screen bg-background">
      <Header title="PredictSys Analytics" subtitle="Painel de métricas da plataforma" />

      <main className="container mx-auto px-4 py-8 space-y-8">
        {/* Filters */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Últimos 7 dias</SelectItem>
                <SelectItem value="30">Últimos 30 dias</SelectItem>
                <SelectItem value="90">Últimos 90 dias</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={refresh} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
            <Button variant="outline" onClick={() => setShowExportModal(true)} disabled={isLoading}>
              <Download className="w-4 h-4 mr-2" />
              Exportar PDF
            </Button>
          </div>

          <ExportAnalyticsPDFModal
            open={showExportModal}
            onOpenChange={setShowExportModal}
            dateRange={dateRange}
            globalKPIs={globalKPIs}
            healthMetrics={healthMetrics}
            organizationUsage={organizationUsage}
            dailyTrend={dailyTrend}
            timeToValue={timeToValue}
          />
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Building2 className="w-4 h-4" /> Orgs Ativas
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold">{globalKPIs.active_organizations}/{globalKPIs.total_organizations}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FolderKanban className="w-4 h-4" /> Projetos
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold">{globalKPIs.projects_created}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Brain className="w-4 h-4" /> Modelos
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold">{globalKPIs.models_trained}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Target className="w-4 h-4" /> Previsões
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold">{globalKPIs.predictions_run}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Zap className="w-4 h-4" /> Exports
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold">{globalKPIs.segments_exported}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Erros
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-8 w-16" /> : (
                <div className="text-2xl font-bold text-destructive">{healthMetrics.total_errors}</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Charts & Tables */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Trend Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5" /> Tendência Diária
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-64" /> : dailyTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={dailyTrend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="models_trained" name="Modelos" stroke="hsl(var(--primary))" />
                    <Line type="monotone" dataKey="predictions_run" name="Previsões" stroke="hsl(var(--chart-2))" />
                    <Line type="monotone" dataKey="jobs_error_count" name="Erros" stroke="hsl(var(--destructive))" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-64 flex items-center justify-center text-muted-foreground">
                  Sem dados no período
                </div>
              )}
            </CardContent>
          </Card>

          {/* Time to Value */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5" /> Time to Value
              </CardTitle>
              <CardDescription>Tempo médio entre etapas do projeto</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingTTV ? <Skeleton className="h-40" /> : (
                <div className="space-y-3">
                  <div className="flex justify-between"><span>Projeto → Dataset</span><Badge variant="secondary">{formatHours(timeToValue.avg_project_to_dataset_hours)}</Badge></div>
                  <div className="flex justify-between"><span>Dataset → Treino</span><Badge variant="secondary">{formatHours(timeToValue.avg_dataset_to_training_hours)}</Badge></div>
                  <div className="flex justify-between"><span>Treino → Previsão</span><Badge variant="secondary">{formatHours(timeToValue.avg_training_to_prediction_hours)}</Badge></div>
                  <div className="flex justify-between"><span>Previsão → Export</span><Badge variant="secondary">{formatHours(timeToValue.avg_prediction_to_export_hours)}</Badge></div>
                  <hr />
                  <div className="flex justify-between font-semibold"><span>Total TTV</span><Badge>{formatHours(timeToValue.avg_total_time_to_value_hours)}</Badge></div>
                  <div className="text-xs text-muted-foreground">
                    {timeToValue.projects_with_export_pct?.toFixed(0) || 0}% dos projetos chegaram ao valor
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Usage by Org */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" /> Uso por Organização
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-64" /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organização</TableHead>
                    <TableHead>Plano</TableHead>
                    <TableHead className="text-center">Projetos</TableHead>
                    <TableHead className="text-center">Modelos</TableHead>
                    <TableHead className="text-center">Previsões</TableHead>
                    <TableHead className="text-center">Usuários</TableHead>
                    <TableHead>Último Evento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizationUsage.map((org: OrganizationUsage) => (
                    <TableRow key={org.organization_id}>
                      <TableCell className="font-medium">{org.organization_name}</TableCell>
                      <TableCell><Badge variant="outline">{org.plan}</Badge></TableCell>
                      <TableCell className="text-center">{org.projects_created}</TableCell>
                      <TableCell className="text-center">{org.models_trained}</TableCell>
                      <TableCell className="text-center">{org.predictions_run}</TableCell>
                      <TableCell className="text-center">{org.active_users}/{org.total_users}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {org.last_event_at ? new Date(org.last_event_at).toLocaleDateString("pt-BR") : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {organizationUsage.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        Nenhum dado no período
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Health Metrics */}
        <Card>
          <CardHeader>
            <CardTitle>Performance da Plataforma</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{formatMs(healthMetrics.avg_import_ms)}</div>
                <div className="text-sm text-muted-foreground">Importação</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{formatMs(healthMetrics.avg_eda_ms)}</div>
                <div className="text-sm text-muted-foreground">EDA</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{formatMs(healthMetrics.avg_train_ms)}</div>
                <div className="text-sm text-muted-foreground">Treinamento</div>
              </div>
              <div className="text-center p-4 bg-muted/50 rounded-lg">
                <div className="text-2xl font-bold">{formatMs(healthMetrics.avg_predict_ms)}</div>
                <div className="text-sm text-muted-foreground">Previsão</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default AdminAnalytics;
