import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Database,
  CheckCircle,
  Clock,
  Trash2,
  FileSpreadsheet,
  Layers,
  Upload,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import { ptBR, es } from "date-fns/locale";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Dataset {
  id: string;
  name: string;
  storage_path: string;
  file_size_bytes: number | null;
  total_rows: number | null;
  sample_rows: number | null;
  columns_count: number | null;
  is_active: boolean;
  source_type: string;
  source_metadata: Record<string, unknown>;
  created_at: string;
}

interface DatasetSelectorProps {
  projectId: string;
  onDatasetChange?: () => void;
}

const DatasetSelector = ({ projectId, onDatasetChange }: DatasetSelectorProps) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const getDateLocale = () => {
    switch (i18n.language) {
      case 'pt': return ptBR;
      case 'es': return es;
      default: return undefined;
    }
  };

  const fetchDatasets = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("project_datasets")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setDatasets((data || []) as Dataset[]);
    } catch (error) {
      console.error("Error fetching datasets:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchDatasets();
    }
  }, [projectId]);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "-";
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const getSourceIcon = (sourceType: string) => {
    switch (sourceType) {
      case 'batch_import':
        return <Layers className="w-4 h-4" />;
      case 'database':
        return <Database className="w-4 h-4" />;
      default:
        return <Upload className="w-4 h-4" />;
    }
  };

  const getSourceLabel = (sourceType: string) => {
    switch (sourceType) {
      case 'batch_import':
        return t("dataIngestion.datasets.sourceBatch");
      case 'database':
        return t("dataIngestion.datasets.sourceDatabase");
      case 'cloud':
        return t("dataIngestion.datasets.sourceCloud");
      default:
        return t("dataIngestion.datasets.sourceUpload");
    }
  };

  const handleActivateDataset = async (datasetId: string) => {
    setActivating(datasetId);
    try {
      const dataset = datasets.find(d => d.id === datasetId);
      if (!dataset) return;

      // Update project_datasets - the trigger will deactivate others
      const { error: datasetError } = await supabase
        .from("project_datasets")
        .update({ is_active: true })
        .eq("id", datasetId);

      if (datasetError) throw datasetError;

      // Update project with the new active dataset info
      const { error: projectError } = await supabase
        .from("projects")
        .update({
          dataset_filename: dataset.storage_path,
          dataset_rows: dataset.sample_rows,
          dataset_columns: dataset.columns_count,
          total_rows: dataset.total_rows,
          sample_rows: dataset.sample_rows,
        })
        .eq("id", projectId);

      if (projectError) throw projectError;

      toast({
        title: t("dataIngestion.datasets.activated"),
        description: t("dataIngestion.datasets.activatedDesc", { name: dataset.name }),
      });

      fetchDatasets();
      onDatasetChange?.();
    } catch (error: any) {
      console.error("Error activating dataset:", error);
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setActivating(null);
    }
  };

  const handleDeleteDataset = async (datasetId: string) => {
    setDeleting(datasetId);
    try {
      const dataset = datasets.find(d => d.id === datasetId);
      if (!dataset) return;

      // Can't delete active dataset
      if (dataset.is_active) {
        toast({
          title: t("common.error"),
          description: t("dataIngestion.datasets.cantDeleteActive"),
          variant: "destructive",
        });
        return;
      }

      // Delete from storage
      const { error: storageError } = await supabase.storage
        .from("datasets")
        .remove([dataset.storage_path]);

      if (storageError) {
        console.warn("Error deleting from storage:", storageError);
      }

      // Delete record
      const { error } = await supabase
        .from("project_datasets")
        .delete()
        .eq("id", datasetId);

      if (error) throw error;

      toast({
        title: t("dataIngestion.datasets.deleted"),
        description: t("dataIngestion.datasets.deletedDesc", { name: dataset.name }),
      });

      fetchDatasets();
    } catch (error: any) {
      console.error("Error deleting dataset:", error);
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (datasets.length === 0) {
    return null; // Don't show if no datasets
  }

  return (
    <Card className="bg-gradient-card shadow-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">{t("dataIngestion.datasets.title")}</h3>
          <Badge variant="secondary" className="ml-2">
            {datasets.length}
          </Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchDatasets}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="max-h-[300px]">
        <div className="space-y-2">
          {datasets.map((dataset) => (
            <div
              key={dataset.id}
              className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                dataset.is_active
                  ? "bg-accent/10 border-accent"
                  : "bg-muted/30 border-border hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex-shrink-0">
                  {dataset.is_active ? (
                    <CheckCircle className="w-5 h-5 text-accent" />
                  ) : (
                    <FileSpreadsheet className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate">{dataset.name}</p>
                    {dataset.is_active && (
                      <Badge variant="default" className="bg-accent text-accent-foreground text-xs">
                        {t("dataIngestion.datasets.active")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      {getSourceIcon(dataset.source_type)}
                      {getSourceLabel(dataset.source_type)}
                    </span>
                    <span>{formatFileSize(dataset.file_size_bytes)}</span>
                    {dataset.total_rows && (
                      <span>{dataset.total_rows.toLocaleString()} {t("dataIngestion.file.rows")}</span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {format(new Date(dataset.created_at), 'PP', { locale: getDateLocale() })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-2">
                {!dataset.is_active && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleActivateDataset(dataset.id)}
                      disabled={activating === dataset.id}
                    >
                      {activating === dataset.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        t("dataIngestion.datasets.activate")
                      )}
                    </Button>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          disabled={deleting === dataset.id}
                        >
                          {deleting === dataset.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("dataIngestion.datasets.deleteTitle")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("dataIngestion.datasets.deleteDesc", { name: dataset.name })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteDataset(dataset.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {t("common.delete")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
};

export default DatasetSelector;