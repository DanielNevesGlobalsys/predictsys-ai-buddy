import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Search,
  Loader2,
  FileSpreadsheet,
  Key,
  Anchor,
  Link2,
} from "lucide-react";

interface FileTargetInfo {
  fileName: string;
  hasTarget: boolean;
  rowCount: number;
}

interface EntityKeyInfo {
  column: string;
  score: number;
  reason: string;
  uniqueRatio: number;
  filesPresent: number;
  totalFiles: number;
}

interface AnchorInfo {
  strategy: "union" | "anchor_enrichment";
  anchor_file: string;
  target_column: string | null;
  target_presence?: { fileName: string; hasTarget: boolean; nullRate: number; rowCount: number }[];
  warnings?: string[];
  joinApplied?: boolean;
  joinKey?: string;
  joinedCells?: number;
}

interface TargetPresenceScanProps {
  projectId: string;
  targetColumn: string | null;
}

const TargetPresenceScan = ({ projectId, targetColumn }: TargetPresenceScanProps) => {
  const [fileInfos, setFileInfos] = useState<FileTargetInfo[]>([]);
  const [entityKeys, setEntityKeys] = useState<EntityKeyInfo[]>([]);
  const [anchorInfo, setAnchorInfo] = useState<AnchorInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanDone, setScanDone] = useState(false);

  useEffect(() => {
    if (targetColumn && projectId) {
      scanTargetPresence();
    } else {
      setFileInfos([]);
      setEntityKeys([]);
      setAnchorInfo(null);
      setScanDone(false);
    }
  }, [targetColumn, projectId]);

  const scanTargetPresence = async () => {
    if (!targetColumn || !projectId) return;
    setLoading(true);

    try {
      const { data: dataset } = await supabase
        .from("project_datasets")
        .select("source_metadata, source_type, total_rows")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle();

      if (!dataset) {
        setLoading(false);
        setScanDone(true);
        return;
      }

      const meta = dataset.source_metadata as Record<string, any> | null;
      const fileNames: string[] = meta?.file_names || [];
      const canonicalHash: string = meta?.canonical_schema_hash || "";

      // Extract entity keys and anchor info from metadata
      const metaEntityKeys: EntityKeyInfo[] = meta?.entity_keys || [];
      setEntityKeys(metaEntityKeys);

      const metaAnchor: AnchorInfo | null = meta?.target_anchor || null;
      setAnchorInfo(metaAnchor);

      // Single-file: no scan needed
      if (fileNames.length <= 1) {
        setFileInfos([{
          fileName: fileNames[0] || "dataset",
          hasTarget: true,
          rowCount: dataset.total_rows || 0,
        }]);
        setScanDone(true);
        setLoading(false);
        return;
      }

      // Use anchor target_presence if available
      if (metaAnchor?.target_presence && metaAnchor.target_presence.length > 0) {
        setFileInfos(metaAnchor.target_presence.map(tp => ({
          fileName: tp.fileName,
          hasTarget: tp.hasTarget,
          rowCount: tp.rowCount,
        })));
        setScanDone(true);
        setLoading(false);
        return;
      }

      // Fallback: check import_jobs + manifests
      const [{ data: jobs }, { data: manifest }] = await Promise.all([
        supabase
          .from("import_jobs")
          .select("file_name, rows_processed, headers_json, batch_sequence")
          .eq("project_id", projectId)
          .eq("status", "completed")
          .order("batch_sequence"),
        supabase
          .from("import_manifests")
          .select("files")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const manifestFiles = (manifest?.files as any[] || []);
      const targetLower = targetColumn.toLowerCase().trim();
      const infos: FileTargetInfo[] = [];

      for (let i = 0; i < fileNames.length; i++) {
        const name = fileNames[i];
        const job = jobs?.find(j => j.file_name === name) || jobs?.[i];
        const mf = manifestFiles.find((f: any) => f.file_name === name) || manifestFiles[i];

        let hasTarget = false;
        if (mf?.schema_detected) {
          const schemaKeys = Object.keys(mf.schema_detected).map((k: string) => k.toLowerCase().trim());
          hasTarget = schemaKeys.includes(targetLower);
        } else if (job?.headers_json) {
          const hdrs = (Array.isArray(job.headers_json) ? job.headers_json : []) as string[];
          hasTarget = hdrs.some((h: string) => h.toLowerCase().trim() === targetLower);
        } else if (canonicalHash) {
          const canonicalCols = canonicalHash.split("|").map((c: string) => c.trim().toLowerCase());
          hasTarget = canonicalCols.includes(targetLower);
        }

        infos.push({ fileName: name, hasTarget, rowCount: job?.rows_processed || 0 });
      }

      setFileInfos(infos);
      setScanDone(true);
    } catch (err) {
      console.error("Target presence scan error:", err);
    }
    setLoading(false);
  };

  if (!targetColumn || !scanDone) return null;
  if (fileInfos.length <= 1 && fileInfos[0]?.hasTarget) return null;

  const filesWithTarget = fileInfos.filter(f => f.hasTarget);
  const filesWithoutTarget = fileInfos.filter(f => !f.hasTarget);
  const targetInAll = filesWithoutTarget.length === 0;
  const targetInOne = filesWithTarget.length === 1;

  if (loading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Verificando presença do target nos arquivos...
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-primary" />
        <h4 className="text-sm font-semibold">Verificação do Target nos Arquivos</h4>
      </div>

      {/* File target presence table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Arquivo</TableHead>
            <TableHead className="text-xs text-center">Target presente</TableHead>
            <TableHead className="text-xs text-right">Linhas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fileInfos.map((f, i) => (
            <TableRow key={i}>
              <TableCell className="text-xs">
                <div className="flex items-center gap-1.5">
                  <FileSpreadsheet className="w-3 h-3 text-muted-foreground" />
                  <span className="truncate max-w-[200px]">{f.fileName}</span>
                  {anchorInfo?.anchor_file === f.fileName && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 border-primary/40 text-primary">
                      <Anchor className="w-2.5 h-2.5 mr-0.5" />
                      âncora
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-center">
                {f.hasTarget ? (
                  <CheckCircle className="w-4 h-4 text-accent inline" />
                ) : (
                  <XCircle className="w-4 h-4 text-destructive inline" />
                )}
              </TableCell>
              <TableCell className="text-xs text-right tabular-nums">
                {f.rowCount.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Strategy recommendation */}
      {targetInAll && (
        <Alert className="border-accent/30 bg-accent/5">
          <CheckCircle className="h-4 w-4 text-accent" />
          <AlertDescription className="text-xs">
            <strong>Target em todos os arquivos</strong> — treinamento usará dataset unificado (union).
          </AlertDescription>
        </Alert>
      )}

      {targetInOne && filesWithoutTarget.length > 0 && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertDescription className="text-xs">
            <strong>Target apenas em "{filesWithTarget[0]?.fileName}"</strong> — este arquivo será usado como dataset âncora.
            Os demais ({filesWithoutTarget.length} arquivo{filesWithoutTarget.length > 1 ? "s" : ""}) serão usados como fonte de features adicionais
            se houver chaves de junção compatíveis.
          </AlertDescription>
        </Alert>
      )}

      {!targetInAll && !targetInOne && filesWithTarget.length > 1 && (
        <Alert className="border-primary/30 bg-primary/5">
          <AlertTriangle className="h-4 w-4 text-primary" />
          <AlertDescription className="text-xs">
            <strong>Target em {filesWithTarget.length} de {fileInfos.length} arquivos</strong> —
            treinamento usará os arquivos com target. Arquivos sem target contribuirão apenas features.
          </AlertDescription>
        </Alert>
      )}

      {/* Entity Keys detected */}
      {entityKeys.length > 0 && (
        <div className="border border-border/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <Key className="w-3.5 h-3.5 text-secondary" />
            <span className="text-xs font-semibold">Chaves de Entidade Detectadas</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {entityKeys.map((ek, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="text-[10px] font-mono gap-1"
                title={ek.reason}
              >
                {ek.column}
                <span className="text-muted-foreground">
                  ({Math.round(ek.uniqueRatio * 100)}% únicos, {ek.filesPresent}/{ek.totalFiles} arquivos)
                </span>
              </Badge>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Essas colunas podem ser usadas como chave de ligação (JOIN) para enriquecer o dataset âncora com features auxiliares.
          </p>
        </div>
      )}

      {/* JOIN applied info */}
      {anchorInfo?.joinApplied && (
        <Alert className="border-accent/30 bg-accent/5">
          <Link2 className="h-4 w-4 text-accent" />
          <AlertDescription className="text-xs">
            <strong>JOIN aplicado com sucesso</strong> — chave: <code className="text-[10px] bg-muted px-1 rounded">{anchorInfo.joinKey}</code>.
            {anchorInfo.joinedCells && <> {anchorInfo.joinedCells.toLocaleString()} células enriquecidas no dataset âncora.</>}
          </AlertDescription>
        </Alert>
      )}

      {/* Anchor warnings */}
      {anchorInfo?.warnings && anchorInfo.warnings.length > 0 && (
        <div className="space-y-1">
          {anchorInfo.warnings.map((w, i) => (
            <p key={i} className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
};

export default TargetPresenceScan;
