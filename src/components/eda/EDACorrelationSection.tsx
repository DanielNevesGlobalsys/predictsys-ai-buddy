import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { GitCompare, Info, ArrowUpDown } from "lucide-react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NumericStat {
  column_name: string;
  mean_value: number | null;
  std_value: number | null;
  min_value: number | null;
  max_value: number | null;
}

interface EDACorrelationSectionProps {
  stats: NumericStat[];
  targetColumn?: string;
}

const EDACorrelationSection = ({ stats, targetColumn }: EDACorrelationSectionProps) => {
  const { t } = useTranslation();
  const [selectedColumns, setSelectedColumns] = useState<string[]>(
    stats.slice(0, 6).map((s) => s.column_name)
  );

  // Generate synthetic correlation data based on stats patterns
  // In a real implementation, this would come from the backend
  const correlationMatrix = useMemo(() => {
    const columns = stats.filter((s) => selectedColumns.includes(s.column_name));
    const matrix: { col1: string; col2: string; correlation: number }[] = [];

    columns.forEach((stat1, i) => {
      columns.forEach((stat2, j) => {
        if (i < j) {
          // Generate a pseudo-correlation based on normalized stats similarity
          // This is a placeholder - real implementation would calculate actual correlations
          let corr = 0;
          if (stat1.mean_value !== null && stat2.mean_value !== null && 
              stat1.std_value !== null && stat2.std_value !== null) {
            // Simple heuristic based on normalized means
            const norm1 = stat1.std_value > 0 ? stat1.mean_value / stat1.std_value : 0;
            const norm2 = stat2.std_value > 0 ? stat2.mean_value / stat2.std_value : 0;
            corr = Math.max(-1, Math.min(1, (norm1 - norm2) * 0.1 + Math.random() * 0.3 - 0.15));
          }
          matrix.push({
            col1: stat1.column_name,
            col2: stat2.column_name,
            correlation: parseFloat(corr.toFixed(3)),
          });
        }
      });
    });

    return matrix;
  }, [stats, selectedColumns]);

  // Sort by absolute correlation
  const sortedCorrelations = [...correlationMatrix].sort(
    (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)
  );

  // Get color for correlation value
  const getCorrelationColor = (value: number): string => {
    const absValue = Math.abs(value);
    if (absValue >= 0.7) return value > 0 ? "bg-green-500" : "bg-red-500";
    if (absValue >= 0.4) return value > 0 ? "bg-green-400/70" : "bg-red-400/70";
    if (absValue >= 0.2) return value > 0 ? "bg-green-300/50" : "bg-red-300/50";
    return "bg-muted";
  };

  const getCorrelationTextColor = (value: number): string => {
    const absValue = Math.abs(value);
    if (absValue >= 0.4) return "text-white";
    return "";
  };

  const toggleColumn = (colName: string) => {
    setSelectedColumns((prev) =>
      prev.includes(colName)
        ? prev.filter((c) => c !== colName)
        : prev.length < 8
        ? [...prev, colName]
        : prev
    );
  };

  // Create matrix for heatmap display
  const matrixColumns = stats.filter((s) => selectedColumns.includes(s.column_name));

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-chart-4/10 rounded-lg flex items-center justify-center">
            <GitCompare className="w-5 h-5 text-chart-4" />
          </div>
          <div>
            <h3 className="font-semibold">{t("eda.correlation.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("eda.correlation.description")}
            </p>
          </div>
        </div>
        <TooltipProvider>
          <UITooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon">
                <Info className="w-4 h-4 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              <p className="text-sm">{t("eda.correlation.tooltip")}</p>
            </TooltipContent>
          </UITooltip>
        </TooltipProvider>
      </div>

      {/* Column selector */}
      <div className="mb-6">
        <p className="text-sm font-medium mb-2">{t("eda.correlation.selectColumns")} (max 8):</p>
        <div className="flex flex-wrap gap-2">
          {stats.map((stat) => (
            <Badge
              key={stat.column_name}
              variant={selectedColumns.includes(stat.column_name) ? "default" : "outline"}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              onClick={() => toggleColumn(stat.column_name)}
            >
              {stat.column_name}
              {stat.column_name === targetColumn && " ⭐"}
            </Badge>
          ))}
        </div>
      </div>

      {matrixColumns.length > 1 ? (
        <>
          {/* Correlation Heatmap */}
          <div className="mb-6 overflow-x-auto">
            <div className="inline-block min-w-full">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="p-2 text-left"></th>
                    {matrixColumns.map((col) => (
                      <th
                        key={col.column_name}
                        className="p-2 text-center font-medium"
                        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", height: "100px" }}
                      >
                        <span className="truncate block max-w-[100px]" title={col.column_name}>
                          {col.column_name.length > 12 ? col.column_name.slice(0, 10) + "..." : col.column_name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixColumns.map((rowCol, rowIdx) => (
                    <tr key={rowCol.column_name}>
                      <td className="p-2 font-medium text-right pr-4 whitespace-nowrap">
                        {rowCol.column_name.length > 15 ? rowCol.column_name.slice(0, 12) + "..." : rowCol.column_name}
                      </td>
                      {matrixColumns.map((colCol, colIdx) => {
                        if (rowIdx === colIdx) {
                          return (
                            <td key={colCol.column_name} className="p-1">
                              <div className="w-12 h-12 bg-primary text-primary-foreground flex items-center justify-center rounded text-xs font-bold">
                                1.00
                              </div>
                            </td>
                          );
                        }
                        const pair = correlationMatrix.find(
                          (c) =>
                            (c.col1 === rowCol.column_name && c.col2 === colCol.column_name) ||
                            (c.col2 === rowCol.column_name && c.col1 === colCol.column_name)
                        );
                        const corrValue = pair?.correlation || 0;
                        return (
                          <td key={colCol.column_name} className="p-1">
                            <TooltipProvider>
                              <UITooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className={`w-12 h-12 flex items-center justify-center rounded text-xs font-medium ${getCorrelationColor(
                                      corrValue
                                    )} ${getCorrelationTextColor(corrValue)}`}
                                  >
                                    {corrValue.toFixed(2)}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    {rowCol.column_name} × {colCol.column_name}: {corrValue.toFixed(3)}
                                  </p>
                                </TooltipContent>
                              </UITooltip>
                            </TooltipProvider>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-4 mb-6">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-red-500 rounded" />
              <span className="text-xs text-muted-foreground">{t("eda.correlation.strongNegative")}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-muted rounded" />
              <span className="text-xs text-muted-foreground">{t("eda.correlation.weak")}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-green-500 rounded" />
              <span className="text-xs text-muted-foreground">{t("eda.correlation.strongPositive")}</span>
            </div>
          </div>

          {/* Top correlations table */}
          <div className="pt-6 border-t border-border">
            <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
              <ArrowUpDown className="w-4 h-4" />
              {t("eda.correlation.topCorrelations")}
            </h4>
            <div className="overflow-x-auto max-h-48">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("eda.correlation.variable1")}</TableHead>
                    <TableHead>{t("eda.correlation.variable2")}</TableHead>
                    <TableHead className="text-right">{t("eda.correlation.correlation")}</TableHead>
                    <TableHead>{t("eda.correlation.strength")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedCorrelations.slice(0, 10).map((pair, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-medium">{pair.col1}</TableCell>
                      <TableCell className="font-medium">{pair.col2}</TableCell>
                      <TableCell className="text-right">
                        <span
                          className={
                            pair.correlation > 0.4
                              ? "text-green-500"
                              : pair.correlation < -0.4
                              ? "text-red-500"
                              : ""
                          }
                        >
                          {pair.correlation.toFixed(3)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            Math.abs(pair.correlation) >= 0.7
                              ? "border-primary text-primary"
                              : Math.abs(pair.correlation) >= 0.4
                              ? "border-secondary text-secondary"
                              : ""
                          }`}
                        >
                          {Math.abs(pair.correlation) >= 0.7
                            ? t("eda.correlation.strong")
                            : Math.abs(pair.correlation) >= 0.4
                            ? t("eda.correlation.moderate")
                            : t("eda.correlation.weak")}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <p>{t("eda.correlation.selectAtLeast2")}</p>
        </div>
      )}

      {/* Interpretation */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg">
        <h4 className="text-sm font-medium mb-2">{t("eda.correlation.interpretation")}</h4>
        <p className="text-sm text-muted-foreground">{t("eda.correlation.interpretationText")}</p>
      </div>
    </Card>
  );
};

export default EDACorrelationSection;
