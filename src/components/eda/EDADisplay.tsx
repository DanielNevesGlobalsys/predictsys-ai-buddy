import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, BarChart3, Calculator, Download, FileSpreadsheet } from "lucide-react";
import EDAKPICards from "./EDAKPICards";
import EDANumericSection from "./EDANumericSection";
import EDACategoricalSection from "./EDACategoricalSection";
import EDAMissingSection from "./EDAMissingSection";
import EDACorrelationSection from "./EDACorrelationSection";
import EDAInsightsSection from "./EDAInsightsSection";
import EDAExportPDF from "./EDAExportPDF";
import { ExportCSVModal, ExportJobsModal } from "@/components/export";

interface NumericStat {
  id: string;
  column_name: string;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  median_value: number | null;
  std_value: number | null;
  null_count: number;
}

interface CategoricalStat {
  id: string;
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

interface EDADisplayProps {
  projectId: string;
  projectName?: string;
  datasetFilename?: string | null;
  onEDAComplete?: () => void;
}

const EDADisplay = ({ projectId, projectName = "Project", datasetFilename, onEDAComplete }: EDADisplayProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [numericStats, setNumericStats] = useState<NumericStat[]>([]);
  const [categoricalStats, setCategoricalStats] = useState<CategoricalStat[]>([]);
  const [hasData, setHasData] = useState(false);
  const [projectHasDataset, setProjectHasDataset] = useState<boolean | null>(null);
  const [projectInfo, setProjectInfo] = useState<{ rows: number; columns: number; target: string | null }>({
    rows: 0, columns: 0, target: null
  });
  const [aiInsights, setAiInsights] = useState<string[]>([]);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportJobsModalOpen, setExportJobsModalOpen] = useState(false);

  useEffect(() => {
    checkProjectDataset();
    loadEDAStats();
  }, [projectId]);

  const checkProjectDataset = async () => {
    if (datasetFilename !== undefined) {
      setProjectHasDataset(!!datasetFilename);
      return;
    }
    try {
      const { data: project } = await supabase
        .from("projects")
        .select("dataset_filename, dataset_rows, dataset_columns, target_column")
        .eq("id", projectId)
        .single();
      setProjectHasDataset(!!project?.dataset_filename);
      setProjectInfo({
        rows: project?.dataset_rows || 0,
        columns: project?.dataset_columns || 0,
        target: project?.target_column || null,
      });
    } catch (error) {
      console.error("Error checking dataset:", error);
      setProjectHasDataset(false);
    }
  };

  const loadEDAStats = async () => {
    setLoading(true);
    try {
      const [numericResult, categoricalResult, projectResult] = await Promise.all([
        supabase.from("project_numeric_stats").select("*").eq("project_id", projectId),
        supabase.from("project_categorical_stats").select("*").eq("project_id", projectId),
        supabase.from("projects").select("dataset_rows, dataset_columns, target_column").eq("id", projectId).single(),
      ]);

      if (projectResult.data) {
        setProjectInfo({
          rows: projectResult.data.dataset_rows || 0,
          columns: projectResult.data.dataset_columns || 0,
          target: projectResult.data.target_column || null,
        });
      }

      if (numericResult.data) setNumericStats(numericResult.data);
      if (categoricalResult.data) {
        const parsed = categoricalResult.data.map((item) => ({
          ...item,
          top_categories: typeof item.top_categories === "string"
            ? JSON.parse(item.top_categories)
            : item.top_categories || [],
        }));
        setCategoricalStats(parsed);
      }

      setHasData((numericResult.data?.length || 0) > 0 || (categoricalResult.data?.length || 0) > 0);
    } catch (error) {
      console.error("Error loading EDA:", error);
    }
    setLoading(false);
  };

  const calculateEDA = async () => {
    setCalculating(true);
    try {
      const { error } = await supabase.functions.invoke("calculate-eda", {
        body: { project_id: projectId },
      });
      if (error) throw error;
      toast({ title: t("eda.calculateSuccess"), description: t("eda.calculateSuccessDesc") });
      await loadEDAStats();
      onEDAComplete?.();
    } catch (error: any) {
      console.error("Error calculating EDA:", error);
      toast({ title: t("eda.calculateError"), description: error.message, variant: "destructive" });
    }
    setCalculating(false);
  };

  // Calculate KPI data
  const totalMissing = numericStats.reduce((sum, s) => sum + s.null_count, 0);
  const totalCells = projectInfo.rows * (numericStats.length + categoricalStats.length);
  const missingPercentage = totalCells > 0 ? (totalMissing / totalCells) * 100 : 0;
  const qualityScore = Math.max(0, Math.min(100, 100 - missingPercentage * 2 - (categoricalStats.filter(c => c.distinct_count > 50).length * 5)));

  const kpiData = {
    totalRows: projectInfo.rows,
    totalColumns: projectInfo.columns || numericStats.length + categoricalStats.length,
    numericCount: numericStats.length,
    categoricalCount: categoricalStats.length,
    missingPercentage,
    targetColumn: projectInfo.target || undefined,
    dataQualityScore: Math.round(qualityScore),
    sampledRows: projectInfo.rows > 50000 ? 50000 : undefined,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (projectHasDataset === false) {
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-destructive/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Calculator className="w-8 h-8 text-destructive" />
        </div>
        <h3 className="text-lg font-semibold mb-2">{t("eda.noDataset")}</h3>
        <p className="text-muted-foreground mb-6 max-w-md mx-auto">{t("eda.noDatasetDesc")}</p>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="text-center py-8">
        <div className="w-16 h-16 bg-secondary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Calculator className="w-8 h-8 text-secondary" />
        </div>
        <h3 className="text-lg font-semibold mb-2">{t("eda.notCalculated")}</h3>
        <p className="text-muted-foreground mb-6 max-w-md mx-auto">{t("eda.notCalculatedDesc")}</p>
        <Button onClick={calculateEDA} disabled={calculating} className="bg-gradient-primary hover:shadow-hover">
          {calculating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("eda.calculating")}</> : <><BarChart3 className="w-4 h-4 mr-2" />{t("eda.calculateNow")}</>}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t("eda.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("eda.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => setExportJobsModalOpen(true)}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span className="ml-2">{t("export.jobsTitle")}</span>
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => setExportModalOpen(true)}
          >
            <Download className="w-4 h-4" />
            <span className="ml-2">{t("common.export")} CSV</span>
          </Button>
          <EDAExportPDF
            projectName={projectName}
            kpiData={kpiData}
            numericStats={numericStats}
            categoricalStats={categoricalStats}
            aiInsights={aiInsights}
          />
          <Button variant="outline" size="sm" onClick={calculateEDA} disabled={calculating}>
            {calculating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-2">{t("eda.recalculate")}</span>
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <EDAKPICards data={kpiData} />

      {/* Numeric Section */}
      {numericStats.length > 0 && <EDANumericSection stats={numericStats} totalRows={projectInfo.rows} />}

      {/* Categorical Section */}
      {categoricalStats.length > 0 && <EDACategoricalSection stats={categoricalStats} totalRows={projectInfo.rows} />}

      {/* Missing Values */}
      <EDAMissingSection numericStats={numericStats} categoricalStats={categoricalStats} totalRows={projectInfo.rows} />

      {/* Correlation */}
      {numericStats.length > 1 && <EDACorrelationSection stats={numericStats} targetColumn={projectInfo.target || undefined} />}

      {/* AI Insights */}
      <EDAInsightsSection
        projectId={projectId}
        numericStats={numericStats}
        categoricalStats={categoricalStats}
        totalRows={projectInfo.rows}
        targetColumn={projectInfo.target || undefined}
        projectName={projectName}
        onInsightsChange={setAiInsights}
      />
      
      {/* Export Modals */}
      <ExportCSVModal
        open={exportModalOpen}
        onOpenChange={setExportModalOpen}
        projectId={projectId}
        exportContext="eda"
        onExportStarted={() => setExportJobsModalOpen(true)}
      />
      
      <ExportJobsModal
        open={exportJobsModalOpen}
        onOpenChange={setExportJobsModalOpen}
        projectId={projectId}
      />
    </div>
  );
};

export default EDADisplay;