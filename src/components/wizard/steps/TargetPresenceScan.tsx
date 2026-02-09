import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
} from "lucide-react";

interface FileTargetInfo {
  fileName: string;
  hasTarget: boolean;
  rowCount: number;
}

interface TargetPresenceScanProps {
  projectId: string;
  targetColumn: string | null;
}

const TargetPresenceScan = ({ projectId, targetColumn }: TargetPresenceScanProps) => {
  const { t } = useTranslation();
  const [fileInfos, setFileInfos] = useState<FileTargetInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanDone, setScanDone] = useState(false);

  useEffect(() => {
    if (targetColumn && projectId) {
      scanTargetPresence();
    } else {
      setFileInfos([]);
      setScanDone(false);
    }
  }, [targetColumn, projectId]);

  const scanTargetPresence = async () => {
    if (!targetColumn || !projectId) return;
    setLoading(true);

    try {
      // Get active dataset metadata
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
      const filePaths: string[] = meta?.file_paths || [];
      const canonicalHash: string = meta?.canonical_schema_hash || "";

      // For single-file datasets
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

      // For batch: check import_jobs to get per-file info
      const { data: jobs } = await supabase
        .from("import_jobs")
        .select("file_name, rows_processed, headers_json, batch_sequence")
        .eq("project_id", projectId)
        .eq("status", "completed")
        .order("batch_sequence");

      // Also check import_manifests for file-level schema info
      const { data: manifest } = await supabase
        .from("import_manifests")
        .select("files")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const manifestFiles = (manifest?.files as any[] || []);
      const targetLower = targetColumn.toLowerCase().trim();

      const infos: FileTargetInfo[] = [];

      for (let i = 0; i < fileNames.length; i++) {
        const name = fileNames[i];
        const job = jobs?.find(j => j.file_name === name) || jobs?.[i];
        const mf = manifestFiles.find((f: any) => f.file_name === name) || manifestFiles[i];

        let hasTarget = false;

        // Check manifest schema_detected
        if (mf?.schema_detected) {
          const schemaKeys = Object.keys(mf.schema_detected).map((k: string) => k.toLowerCase().trim());
          hasTarget = schemaKeys.includes(targetLower);
        }
        // Fallback: check headers_json from import_jobs
        else if (job?.headers_json) {
          const hdrs = (Array.isArray(job.headers_json) ? job.headers_json : []) as string[];
          hasTarget = hdrs.some((h: string) => h.toLowerCase().trim() === targetLower);
        }
        // Fallback: if canonical schema includes it, assume present 
        else if (canonicalHash) {
          const canonicalCols = canonicalHash.split("|").map((c: string) => c.trim().toLowerCase());
          hasTarget = canonicalCols.includes(targetLower);
        }

        infos.push({
          fileName: name,
          hasTarget,
          rowCount: job?.rows_processed || 0,
        });
      }

      setFileInfos(infos);
      setScanDone(true);
    } catch (err) {
      console.error("Target presence scan error:", err);
    }
    setLoading(false);
  };

  if (!targetColumn || !scanDone) return null;
  if (fileInfos.length <= 1 && fileInfos[0]?.hasTarget) return null; // Single file with target = no scan needed

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

      {/* Recommendation */}
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
    </Card>
  );
};

export default TargetPresenceScan;
