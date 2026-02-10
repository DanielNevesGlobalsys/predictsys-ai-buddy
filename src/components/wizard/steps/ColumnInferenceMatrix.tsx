import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  AlertTriangle,
  Shield,
  Clock,
  Hash,
  Tag,
  FileText,
  Zap,
  HelpCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export interface ColumnInferenceRow {
  column_name: string;
  inferred_type: string;
  semantic_role: string;
  temporal_role: string;
  can_be_target: boolean;
  can_be_feature: boolean;
  block_reasons: string[];
  confidence_score: number;
  classification_reasons: string[];
}

interface ColumnInferenceMatrixProps {
  projectId: string;
  onDataLoaded?: (data: ColumnInferenceRow[]) => void;
}

const ROLE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  ID_TECNICO: { icon: <Hash className="w-3 h-3" />, label: "ID", color: "bg-muted text-muted-foreground" },
  TEMPO: { icon: <Clock className="w-3 h-3" />, label: "TEMPO", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  DIMENSAO_NEGOCIO: { icon: <Tag className="w-3 h-3" />, label: "DIMENSÃO", color: "bg-purple-500/15 text-purple-700 dark:text-purple-400" },
  MEDIDA_NUMERICA: { icon: <BarChart3 className="w-3 h-3" />, label: "MEDIDA", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  CATEGORICA: { icon: <Tag className="w-3 h-3" />, label: "CATEG.", color: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400" },
  TEXTO: { icon: <FileText className="w-3 h-3" />, label: "TEXTO", color: "bg-slate-500/15 text-slate-700 dark:text-slate-400" },
  TARGET_CANDIDATO_EVENTO: { icon: <Zap className="w-3 h-3" />, label: "EVENTO", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  TARGET_CANDIDATO_ESTADO: { icon: <Shield className="w-3 h-3" />, label: "ESTADO", color: "bg-orange-500/15 text-orange-700 dark:text-orange-400" },
  DERIVADA_LEAKAGE: { icon: <AlertTriangle className="w-3 h-3" />, label: "LEAKAGE", color: "bg-destructive/15 text-destructive" },
  DESCONHECIDO: { icon: <HelpCircle className="w-3 h-3" />, label: "?", color: "bg-muted text-muted-foreground" },
};

const TEMPORAL_CONFIG: Record<string, { label: string; color: string }> = {
  PRE_EVENTO: { label: "PRÉ", color: "bg-accent/15 text-accent" },
  POS_EVENTO: { label: "PÓS", color: "bg-destructive/15 text-destructive" },
  DESCONHECIDO: { label: "—", color: "text-muted-foreground" },
};

const ColumnInferenceMatrix = ({ projectId, onDataLoaded }: ColumnInferenceMatrixProps) => {
  const { t } = useTranslation();
  const [data, setData] = useState<ColumnInferenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    loadData();
  }, [projectId]);

  const loadData = async () => {
    setLoading(true);
    const { data: rows, error } = await supabase
      .from("project_column_inference")
      .select("column_name, inferred_type, semantic_role, temporal_role, can_be_target, can_be_feature, block_reasons, confidence_score, classification_reasons")
      .eq("project_id", projectId)
      .order("column_name");

    if (!error && rows && rows.length > 0) {
      const mapped = rows.map((r: any) => ({
        column_name: r.column_name,
        inferred_type: r.inferred_type,
        semantic_role: r.semantic_role,
        temporal_role: r.temporal_role,
        can_be_target: r.can_be_target,
        can_be_feature: r.can_be_feature,
        block_reasons: r.block_reasons || [],
        confidence_score: Number(r.confidence_score),
        classification_reasons: r.classification_reasons || [],
      }));
      setData(mapped);
      onDataLoaded?.(mapped);
    }
    setLoading(false);
  };

  if (loading || data.length === 0) return null;

  const targetCount = data.filter(d => d.can_be_target).length;
  const featureCount = data.filter(d => d.can_be_feature).length;
  const blockedCount = data.filter(d => d.block_reasons.length > 0).length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between p-4 h-auto border border-border rounded-xl hover:bg-muted/50"
        >
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-secondary" />
            <span className="font-semibold text-sm">
              {t("columnInference.title", "📊 Inferência por Coluna")}
            </span>
            <Badge variant="outline" className="text-xs">
              {data.length} {t("columnInference.columns", "colunas")}
            </Badge>
            <Badge className="bg-accent/15 text-accent text-xs">
              {targetCount} targets
            </Badge>
            <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-xs">
              {featureCount} features
            </Badge>
            {blockedCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {blockedCount} bloqueadas
              </Badge>
            )}
          </div>
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 border border-border rounded-xl overflow-hidden">
          <div className="max-h-[400px] overflow-auto">
            <TooltipProvider delayDuration={200}>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs font-semibold min-w-[140px]">
                      {t("columnInference.columnName", "Coluna")}
                    </TableHead>
                    <TableHead className="text-xs font-semibold">
                      {t("columnInference.type", "Tipo")}
                    </TableHead>
                    <TableHead className="text-xs font-semibold">
                      {t("columnInference.semanticRole", "Papel Semântico")}
                    </TableHead>
                    <TableHead className="text-xs font-semibold">
                      {t("columnInference.temporalRole", "Temporal")}
                    </TableHead>
                    <TableHead className="text-xs font-semibold text-center">
                      Target?
                    </TableHead>
                    <TableHead className="text-xs font-semibold text-center">
                      Feature?
                    </TableHead>
                    <TableHead className="text-xs font-semibold text-center">
                      {t("columnInference.confidence", "Conf.")}
                    </TableHead>
                    <TableHead className="text-xs font-semibold">
                      {t("columnInference.blockReason", "Motivo bloqueio")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((row) => {
                    const roleConfig = ROLE_CONFIG[row.semantic_role] || ROLE_CONFIG.DESCONHECIDO;
                    const temporalConfig = TEMPORAL_CONFIG[row.temporal_role] || TEMPORAL_CONFIG.DESCONHECIDO;
                    const hasBlocks = row.block_reasons.length > 0;

                    return (
                      <TableRow
                        key={row.column_name}
                        className={hasBlocks ? "bg-destructive/5" : ""}
                      >
                        <TableCell className="font-mono text-xs py-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">{row.column_name}</span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <div className="space-y-1">
                                <p className="font-semibold text-xs">{row.column_name}</p>
                                {row.classification_reasons.map((r, i) => (
                                  <p key={i} className="text-xs text-muted-foreground">• {r}</p>
                                ))}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className="text-xs">
                            {row.inferred_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge className={`text-xs gap-1 ${roleConfig.color}`}>
                            {roleConfig.icon}
                            {roleConfig.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2">
                          <span className={`text-xs font-medium ${temporalConfig.color}`}>
                            {temporalConfig.label}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-center">
                          {row.can_be_target ? (
                            <Check className="w-4 h-4 text-accent mx-auto" />
                          ) : (
                            <X className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="py-2 text-center">
                          {row.can_be_feature ? (
                            <Check className="w-4 h-4 text-accent mx-auto" />
                          ) : (
                            <X className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="py-2 text-center">
                          <span className={`text-xs font-medium ${
                            row.confidence_score >= 0.8 ? "text-accent" :
                            row.confidence_score >= 0.5 ? "text-secondary" :
                            "text-muted-foreground"
                          }`}>
                            {(row.confidence_score * 100).toFixed(0)}%
                          </span>
                        </TableCell>
                        <TableCell className="py-2">
                          {hasBlocks ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1 cursor-help">
                                  <AlertTriangle className="w-3 h-3 text-destructive flex-shrink-0" />
                                  <span className="text-xs text-destructive truncate max-w-[150px]">
                                    {row.block_reasons[0]}
                                  </span>
                                  {row.block_reasons.length > 1 && (
                                    <Badge variant="destructive" className="text-xs">
                                      +{row.block_reasons.length - 1}
                                    </Badge>
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs">
                                <div className="space-y-1">
                                  <p className="font-semibold text-xs">Motivos de bloqueio:</p>
                                  {row.block_reasons.map((r, i) => (
                                    <p key={i} className="text-xs">• {r}</p>
                                  ))}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TooltipProvider>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export default ColumnInferenceMatrix;
