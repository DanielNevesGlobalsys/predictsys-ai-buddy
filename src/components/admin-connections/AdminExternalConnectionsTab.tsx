import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Plug, Radar, Download, RefreshCw, ArrowUpCircle, Search,
  Loader2, CheckCircle, AlertCircle, Clock, Eye, FileJson, Package,
  Database, Layers, Activity,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";

// ─── Types ───────────────────────────────────────
interface Connection {
  id: string;
  connection_name: string;
  connector_type: string;
  connection_status: string;
  project_id: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, any> | null;
}

interface DiscoveryRun {
  id: string;
  connection_id: string;
  project_id: string;
  status: string;
  objects_found: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  reasons: string[] | null;
  evidence: Record<string, any> | null;
}

interface DiscoveryObject {
  id: string;
  discovery_run_id: string;
  connection_id: string;
  project_id: string;
  object_name: string;
  object_type: string;
  object_schema: string | null;
  estimated_columns: number | null;
  estimated_rows: number | null;
  last_updated_at: string | null;
  classification: string | null;
  column_preview: any[] | null;
  sample_rows: any[] | null;
  is_selected: boolean;
  metadata: Record<string, any> | null;
}

interface ImportRun {
  id: string;
  connection_id: string;
  project_id: string;
  status: string;
  total_objects: number;
  objects_completed: number;
  objects_failed: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  reasons: string[] | null;
  evidence: Record<string, any> | null;
}

interface ImportObject {
  id: string;
  import_run_id: string;
  project_id: string;
  object_name: string;
  status: string;
  storage_path: string | null;
  rows_imported: number | null;
  columns_imported: number | null;
  file_size_bytes: number | null;
  dataset_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

// ─── Status Badge ────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
    active: { variant: "default", icon: <CheckCircle className="w-3 h-3" /> },
    done: { variant: "default", icon: <CheckCircle className="w-3 h-3" /> },
    success: { variant: "default", icon: <CheckCircle className="w-3 h-3" /> },
    staged: { variant: "secondary", icon: <Package className="w-3 h-3" /> },
    promoted: { variant: "default", icon: <ArrowUpCircle className="w-3 h-3" /> },
    running: { variant: "secondary", icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    importing: { variant: "secondary", icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    failed: { variant: "destructive", icon: <AlertCircle className="w-3 h-3" /> },
    inactive: { variant: "outline", icon: <Clock className="w-3 h-3" /> },
  };
  const v = variants[status] || { variant: "outline" as const, icon: null };
  return (
    <Badge variant={v.variant} className="gap-1 text-xs">
      {v.icon}
      {status}
    </Badge>
  );
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  try {
    return formatDistanceToNow(new Date(d), { addSuffix: true, locale: ptBR });
  } catch {
    return d;
  }
}

function duration(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// ═══════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════
const AdminExternalConnectionsTab = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryRun[]>([]);
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);

  // Detail modals
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [connectionDetail, setConnectionDetail] = useState<{ runs: DiscoveryRun[]; imports: ImportRun[]; objects: DiscoveryObject[] } | null>(null);
  const [selectedDiscoveryRun, setSelectedDiscoveryRun] = useState<DiscoveryRun | null>(null);
  const [discoveryObjects, setDiscoveryObjects] = useState<DiscoveryObject[]>([]);
  const [selectedImportRun, setSelectedImportRun] = useState<ImportRun | null>(null);
  const [importObjects, setImportObjects] = useState<ImportObject[]>([]);
  const [jsonModal, setJsonModal] = useState<{ title: string; data: any } | null>(null);

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // ─── Load all data ─────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [connsRes, discRes, impRes] = await Promise.all([
        supabase.from("external_connections").select("*").order("created_at", { ascending: false }),
        supabase.from("external_discovery_runs").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("external_import_runs").select("*").order("created_at", { ascending: false }).limit(100),
      ]);
      setConnections((connsRes.data || []) as Connection[]);
      setDiscoveryRuns((discRes.data || []) as DiscoveryRun[]);
      setImportRuns((impRes.data || []) as ImportRun[]);
    } catch (e) {
      console.error("[admin-connections] load error", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Summary KPIs ──────────────────────────────
  const totalConnections = connections.length;
  const activeConnections = connections.filter(c => c.connection_status === "active").length;
  const lastDiscovery = discoveryRuns[0];
  const lastImport = importRuns[0];
  const totalObjectsDiscovered = discoveryRuns.reduce((s, r) => s + (r.objects_found || 0), 0);
  const totalImported = importRuns.reduce((s, r) => s + (r.objects_completed || 0), 0);
  const totalImportErrors = importRuns.reduce((s, r) => s + (r.objects_failed || 0), 0);

  // ─── Connection detail ─────────────────────────
  const openConnectionDetail = useCallback(async (connId: string) => {
    setSelectedConnectionId(connId);
    const [runsRes, impsRes, objsRes] = await Promise.all([
      supabase.from("external_discovery_runs").select("*").eq("connection_id", connId).order("created_at", { ascending: false }).limit(20),
      supabase.from("external_import_runs").select("*").eq("connection_id", connId).order("created_at", { ascending: false }).limit(20),
      supabase.from("external_discovery_objects").select("*").eq("connection_id", connId).order("object_name").limit(200),
    ]);
    setConnectionDetail({
      runs: (runsRes.data || []) as DiscoveryRun[],
      imports: (impsRes.data || []) as ImportRun[],
      objects: (objsRes.data || []) as DiscoveryObject[],
    });
  }, []);

  // ─── Discovery run detail ─────────────────────
  const openDiscoveryRunDetail = useCallback(async (run: DiscoveryRun) => {
    setSelectedDiscoveryRun(run);
    const { data } = await supabase
      .from("external_discovery_objects")
      .select("*")
      .eq("discovery_run_id", run.id)
      .order("object_name");
    setDiscoveryObjects((data || []) as DiscoveryObject[]);
  }, []);

  // ─── Import run detail ────────────────────────
  const openImportRunDetail = useCallback(async (run: ImportRun) => {
    setSelectedImportRun(run);
    const { data } = await supabase
      .from("external_import_objects")
      .select("*")
      .eq("import_run_id", run.id)
      .order("object_name");
    setImportObjects((data || []) as ImportObject[]);
  }, []);

  // ─── Actions ──────────────────────────────────
  const rerunDiscovery = useCallback(async (connectionId: string, projectId: string) => {
    setActionLoading(`discovery-${connectionId}`);
    try {
      const { data, error } = await supabase.functions.invoke("discover-external-objects", {
        body: { connection_id: connectionId, project_id: projectId },
      });
      if (error) throw error;
      toast({ title: "Discovery reexecutado", description: `${data?.objects_found || 0} objetos encontrados` });
      await loadAll();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  }, [toast, loadAll]);

  const rerunImport = useCallback(async (importRun: ImportRun) => {
    setActionLoading(`import-${importRun.id}`);
    try {
      // Get objects from the original import run
      const { data: objs } = await supabase
        .from("external_import_objects")
        .select("discovery_object_id")
        .eq("import_run_id", importRun.id);
      
      if (!objs?.length) throw new Error("No objects found for this import run");

      const objectIds = objs.map(o => o.discovery_object_id);
      const { data, error } = await supabase.functions.invoke("import-external-objects", {
        body: { project_id: importRun.project_id, object_ids: objectIds, promote: false },
      });
      if (error) throw error;
      toast({ title: "Import reexecutado", description: `${data?.completed || 0} importados, ${data?.failed || 0} falharam` });
      await loadAll();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  }, [toast, loadAll]);

  const promoteStaging = useCallback(async (importRunId: string, projectId: string) => {
    setActionLoading(`promote-${importRunId}`);
    try {
      const { data, error } = await supabase.functions.invoke("promote-staging", {
        body: { import_run_id: importRunId, project_id: projectId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Promotion failed");
      toast({ title: "Staging promovido", description: `Dataset ativo criado: ${data.dataset_id}` });
      await loadAll();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  }, [toast, loadAll]);

  const exportDiagnostic = useCallback(async (connectionId: string) => {
    try {
      const [conns, disc, objs, imps, impObjs] = await Promise.all([
        supabase.from("external_connections").select("*").eq("id", connectionId),
        supabase.from("external_discovery_runs").select("*").eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(10),
        supabase.from("external_discovery_objects").select("*").eq("connection_id", connectionId).order("object_name"),
        supabase.from("external_import_runs").select("*").eq("connection_id", connectionId).order("created_at", { ascending: false }).limit(10),
        supabase.from("external_import_objects").select("*").eq("import_run_id", connectionId), // will get none, but we'll merge below
      ]);

      // Get import objects for all import runs of this connection
      const importRunIds = (imps.data || []).map((r: any) => r.id);
      let allImportObjs: any[] = [];
      if (importRunIds.length > 0) {
        const { data } = await supabase.from("external_import_objects").select("*").in("import_run_id", importRunIds);
        allImportObjs = data || [];
      }

      const diagnostic = {
        exported_at: new Date().toISOString(),
        connection: conns.data?.[0] || null,
        discovery_runs: disc.data || [],
        discovered_objects: objs.data || [],
        import_runs: imps.data || [],
        import_objects: allImportObjs,
      };

      const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `diagnostic_${connectionId.substring(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Diagnóstico exportado" });
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  }, [toast]);

  // ─── Filtered connections ──────────────────────
  const filtered = connections.filter(c =>
    c.connection_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.connector_type.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selectedConnection = connections.find(c => c.id === selectedConnectionId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ═══ Summary Cards ═══ */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
        {[
          { label: "Conexões", value: totalConnections, icon: Plug },
          { label: "Ativas", value: activeConnections, icon: CheckCircle },
          { label: "Último Discovery", value: lastDiscovery ? fmtDate(lastDiscovery.created_at) : "—", icon: Radar },
          { label: "Último Import", value: lastImport ? fmtDate(lastImport.created_at) : "—", icon: Download },
          { label: "Objetos Descobertos", value: totalObjectsDiscovered, icon: Database },
          { label: "Objetos Importados", value: totalImported, icon: Package },
          { label: "Erros Import", value: totalImportErrors, icon: AlertCircle },
        ].map((kpi, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <kpi.icon className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{kpi.label}</span>
              </div>
              <p className="text-lg font-semibold">{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ═══ Sub-tabs ═══ */}
      <Tabs defaultValue="connections" className="space-y-4">
        <TabsList>
          <TabsTrigger value="connections" className="gap-1"><Plug className="w-3 h-3" />Conexões</TabsTrigger>
          <TabsTrigger value="discovery" className="gap-1"><Radar className="w-3 h-3" />Discovery Runs</TabsTrigger>
          <TabsTrigger value="imports" className="gap-1"><Download className="w-3 h-3" />Import Runs</TabsTrigger>
        </TabsList>

        {/* ═══ Connections ═══ */}
        <TabsContent value="connections" className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Buscar conexão..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="pl-9" />
            </div>
            <Button variant="outline" size="sm" onClick={loadAll}><RefreshCw className="w-4 h-4 mr-1" />Atualizar</Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Projeto</TableHead>
                    <TableHead>Criada</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(conn => (
                    <TableRow key={conn.id}>
                      <TableCell className="font-medium">{conn.connection_name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{conn.connector_type}</Badge></TableCell>
                      <TableCell><StatusBadge status={conn.connection_status} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{conn.project_id.substring(0, 8)}…</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(conn.created_at)}</TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button variant="ghost" size="sm" onClick={() => openConnectionDetail(conn.id)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          disabled={actionLoading === `discovery-${conn.id}`}
                          onClick={() => rerunDiscovery(conn.id, conn.project_id)}
                        >
                          {actionLoading === `discovery-${conn.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => exportDiagnostic(conn.id)}>
                          <FileJson className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Nenhuma conexão encontrada</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ Discovery Runs ═══ */}
        <TabsContent value="discovery" className="space-y-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run ID</TableHead>
                    <TableHead>Conexão</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Objetos</TableHead>
                    <TableHead>Início</TableHead>
                    <TableHead>Duração</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {discoveryRuns.map(run => (
                    <TableRow key={run.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openDiscoveryRunDetail(run)}>
                      <TableCell className="font-mono text-xs">{run.id.substring(0, 8)}…</TableCell>
                      <TableCell className="font-mono text-xs">{run.connection_id.substring(0, 8)}…</TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell className="text-center">{run.objects_found}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(run.started_at || run.created_at)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{duration(run.started_at, run.finished_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); setJsonModal({ title: "Evidence", data: run.evidence }); }}>
                          <FileJson className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {discoveryRuns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Nenhum discovery run</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ Import Runs ═══ */}
        <TabsContent value="imports" className="space-y-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run ID</TableHead>
                    <TableHead>Conexão</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Total</TableHead>
                    <TableHead className="text-center">OK</TableHead>
                    <TableHead className="text-center">Falhas</TableHead>
                    <TableHead>Início</TableHead>
                    <TableHead>Duração</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importRuns.map(run => (
                    <TableRow key={run.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openImportRunDetail(run)}>
                      <TableCell className="font-mono text-xs">{run.id.substring(0, 8)}…</TableCell>
                      <TableCell className="font-mono text-xs">{run.connection_id.substring(0, 8)}…</TableCell>
                      <TableCell><StatusBadge status={run.status} /></TableCell>
                      <TableCell className="text-center">{run.total_objects}</TableCell>
                      <TableCell className="text-center text-primary">{run.objects_completed}</TableCell>
                      <TableCell className="text-center text-destructive">{run.objects_failed}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(run.started_at || run.created_at)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{duration(run.started_at, run.finished_at)}</TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost" size="sm"
                          disabled={actionLoading === `import-${run.id}`}
                          onClick={e => { e.stopPropagation(); rerunImport(run); }}
                          title="Reexecutar import"
                        >
                          {actionLoading === `import-${run.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          disabled={actionLoading === `promote-${run.id}` || run.status !== "done"}
                          onClick={e => { e.stopPropagation(); promoteStaging(run.id, run.project_id); }}
                          title="Promover staging"
                        >
                          {actionLoading === `promote-${run.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpCircle className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); setJsonModal({ title: "Evidence", data: run.evidence }); }}>
                          <FileJson className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {importRuns.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Nenhum import run</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ═══ Connection Detail Modal ═══ */}
      <Dialog open={!!selectedConnectionId} onOpenChange={() => { setSelectedConnectionId(null); setConnectionDetail(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plug className="w-5 h-5" />
              {selectedConnection?.connection_name || "Conexão"}
            </DialogTitle>
            <DialogDescription>
              {selectedConnection?.connector_type} • {selectedConnection?.id}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            {connectionDetail && (
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium mb-2">Últimos Discovery Runs ({connectionDetail.runs.length})</h4>
                  {connectionDetail.runs.map(r => (
                    <div key={r.id} className="flex items-center justify-between py-2 border-b border-border">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span className="text-sm">{r.objects_found} objetos</span>
                        <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => openDiscoveryRunDetail(r)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2">Últimos Import Runs ({connectionDetail.imports.length})</h4>
                  {connectionDetail.imports.map(r => (
                    <div key={r.id} className="flex items-center justify-between py-2 border-b border-border">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span className="text-sm">{r.objects_completed}/{r.total_objects}</span>
                        <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => openImportRunDetail(r)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2">Objetos Descobertos ({connectionDetail.objects.length})</h4>
                  <div className="grid gap-2">
                    {connectionDetail.objects.slice(0, 20).map(obj => (
                      <div key={obj.id} className="flex items-center justify-between p-2 rounded border border-border">
                        <div className="flex items-center gap-2">
                          <Layers className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{obj.object_name}</span>
                          <Badge variant="outline" className="text-xs">{obj.object_type}</Badge>
                          {obj.classification && <Badge variant="secondary" className="text-xs">{obj.classification}</Badge>}
                          {obj.is_selected && <Badge className="text-xs">selecionado</Badge>}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {obj.estimated_columns || "?"} cols • {obj.estimated_rows?.toLocaleString() || "?"} rows
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ═══ Discovery Run Detail Modal ═══ */}
      <Dialog open={!!selectedDiscoveryRun} onOpenChange={() => { setSelectedDiscoveryRun(null); setDiscoveryObjects([]); }}>
        <DialogContent className="max-w-3xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radar className="w-5 h-5" />
              Discovery Run
            </DialogTitle>
            <DialogDescription>
              {selectedDiscoveryRun?.id} • <StatusBadge status={selectedDiscoveryRun?.status || ""} />
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-4">
              {selectedDiscoveryRun?.error_message && (
                <Card className="bg-destructive/5 border-destructive/20">
                  <CardContent className="p-3 text-sm text-destructive">{selectedDiscoveryRun.error_message}</CardContent>
                </Card>
              )}

              <div className="grid grid-cols-3 gap-3 text-sm">
                <div><span className="text-muted-foreground">Início:</span> {fmtDate(selectedDiscoveryRun?.started_at)}</div>
                <div><span className="text-muted-foreground">Fim:</span> {fmtDate(selectedDiscoveryRun?.finished_at)}</div>
                <div><span className="text-muted-foreground">Duração:</span> {duration(selectedDiscoveryRun?.started_at || null, selectedDiscoveryRun?.finished_at || null)}</div>
              </div>

              <h4 className="text-sm font-medium">Objetos Descobertos ({discoveryObjects.length})</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Schema</TableHead>
                    <TableHead>Classificação</TableHead>
                    <TableHead className="text-center">Colunas</TableHead>
                    <TableHead className="text-center">Linhas</TableHead>
                    <TableHead>Selecionado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {discoveryObjects.map(obj => (
                    <TableRow key={obj.id}>
                      <TableCell className="font-medium text-sm">{obj.object_name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{obj.object_type}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{obj.object_schema || "—"}</TableCell>
                      <TableCell>{obj.classification ? <Badge variant="secondary" className="text-xs">{obj.classification}</Badge> : "—"}</TableCell>
                      <TableCell className="text-center">{obj.estimated_columns || "—"}</TableCell>
                      <TableCell className="text-center">{obj.estimated_rows?.toLocaleString() || "—"}</TableCell>
                      <TableCell>{obj.is_selected ? <CheckCircle className="w-4 h-4 text-primary" /> : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline" size="sm"
                  disabled={!selectedDiscoveryRun || actionLoading === `discovery-${selectedDiscoveryRun?.connection_id}`}
                  onClick={() => selectedDiscoveryRun && rerunDiscovery(selectedDiscoveryRun.connection_id, selectedDiscoveryRun.project_id)}
                >
                  <RefreshCw className="w-4 h-4 mr-1" />Reexecutar Discovery
                </Button>
                <Button variant="outline" size="sm" onClick={() => setJsonModal({ title: "Evidence JSON", data: selectedDiscoveryRun?.evidence })}>
                  <FileJson className="w-4 h-4 mr-1" />Ver Evidence
                </Button>
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ═══ Import Run Detail Modal ═══ */}
      <Dialog open={!!selectedImportRun} onOpenChange={() => { setSelectedImportRun(null); setImportObjects([]); }}>
        <DialogContent className="max-w-4xl max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Import Run
            </DialogTitle>
            <DialogDescription>
              {selectedImportRun?.id} • <StatusBadge status={selectedImportRun?.status || ""} />
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3 text-sm">
                <div><span className="text-muted-foreground">Início:</span> {fmtDate(selectedImportRun?.started_at)}</div>
                <div><span className="text-muted-foreground">Fim:</span> {fmtDate(selectedImportRun?.finished_at)}</div>
                <div><span className="text-muted-foreground">Duração:</span> {duration(selectedImportRun?.started_at || null, selectedImportRun?.finished_at || null)}</div>
                <div><span className="text-muted-foreground">Objetos:</span> {selectedImportRun?.objects_completed}/{selectedImportRun?.total_objects}</div>
              </div>

              <h4 className="text-sm font-medium">Objetos Importados ({importObjects.length})</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Storage Path</TableHead>
                    <TableHead className="text-center">Linhas</TableHead>
                    <TableHead className="text-center">Colunas</TableHead>
                    <TableHead>Tamanho</TableHead>
                    <TableHead>Dataset ID</TableHead>
                    <TableHead>Erro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importObjects.map(obj => (
                    <TableRow key={obj.id}>
                      <TableCell className="font-medium text-sm">{obj.object_name}</TableCell>
                      <TableCell><StatusBadge status={obj.status} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">{obj.storage_path || "—"}</TableCell>
                      <TableCell className="text-center">{obj.rows_imported?.toLocaleString() || "—"}</TableCell>
                      <TableCell className="text-center">{obj.columns_imported || "—"}</TableCell>
                      <TableCell className="text-xs">{obj.file_size_bytes ? `${(obj.file_size_bytes / 1024).toFixed(1)}KB` : "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{obj.dataset_id ? `${obj.dataset_id.substring(0, 8)}…` : "—"}</TableCell>
                      <TableCell className="text-xs text-destructive max-w-[150px] truncate" title={obj.error_message || ""}>{obj.error_message || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline" size="sm"
                  disabled={!selectedImportRun || actionLoading === `import-${selectedImportRun?.id}`}
                  onClick={() => selectedImportRun && rerunImport(selectedImportRun)}
                >
                  <RefreshCw className="w-4 h-4 mr-1" />Reexecutar Import
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={!selectedImportRun || selectedImportRun.status !== "done" || actionLoading === `promote-${selectedImportRun?.id}`}
                  onClick={() => selectedImportRun && promoteStaging(selectedImportRun.id, selectedImportRun.project_id)}
                >
                  {actionLoading === `promote-${selectedImportRun?.id}` ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ArrowUpCircle className="w-4 h-4 mr-1" />}
                  Promover Staging
                </Button>
                <Button variant="outline" size="sm" onClick={() => setJsonModal({ title: "Evidence JSON", data: selectedImportRun?.evidence })}>
                  <FileJson className="w-4 h-4 mr-1" />Ver Evidence
                </Button>
              </div>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ═══ JSON Viewer Modal ═══ */}
      <Dialog open={!!jsonModal} onOpenChange={() => setJsonModal(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{jsonModal?.title}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <pre className="text-xs font-mono bg-muted p-4 rounded overflow-auto whitespace-pre-wrap">
              {jsonModal?.data ? JSON.stringify(jsonModal.data, null, 2) : "null"}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminExternalConnectionsTab;
