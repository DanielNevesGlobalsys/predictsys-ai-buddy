import { useMemo } from "react";
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
import { Progress } from "@/components/ui/progress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { AlertTriangle, Info, CheckCircle2 } from "lucide-react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NumericStat {
  column_name: string;
  null_count: number;
}

interface CategoricalStat {
  column_name: string;
  top_categories: { category: string; count: number }[];
}

interface EDAMissingSectionProps {
  numericStats: NumericStat[];
  categoricalStats: CategoricalStat[];
  totalRows: number;
}

const EDAMissingSection = ({ numericStats, categoricalStats, totalRows }: EDAMissingSectionProps) => {
  const { t } = useTranslation();

  // Calculate missing values for all columns
  const missingData = useMemo(() => {
    const data: { column: string; nullCount: number; percentage: number; type: string }[] = [];

    // Add numeric columns
    numericStats.forEach((stat) => {
      data.push({
        column: stat.column_name,
        nullCount: stat.null_count,
        percentage: (stat.null_count / totalRows) * 100,
        type: t("eda.missing.numeric"),
      });
    });

    // Add categorical columns - estimate missing from (vazio) category
    categoricalStats.forEach((stat) => {
      const safeCats = Array.isArray(stat.top_categories) ? stat.top_categories : [];
      const emptyCategory = safeCats.find(
        (c) => c.category === "(vazio)" || c.category === "(empty)" || c.category === ""
      );
      const nullCount = emptyCategory?.count || 0;
      data.push({
        column: stat.column_name,
        nullCount,
        percentage: (nullCount / totalRows) * 100,
        type: t("eda.missing.categorical"),
      });
    });

    // Sort by missing percentage descending
    return data.sort((a, b) => b.percentage - a.percentage);
  }, [numericStats, categoricalStats, totalRows, t]);

  // Only show columns with missing values in chart
  const chartData = missingData
    .filter((d) => d.nullCount > 0)
    .slice(0, 15)
    .map((d, index) => ({
      column: d.column.length > 15 ? d.column.slice(0, 12) + "..." : d.column,
      fullColumn: d.column,
      percentage: parseFloat(d.percentage.toFixed(1)),
      count: d.nullCount,
      color:
        d.percentage > 50
          ? "hsl(var(--destructive))"
          : d.percentage > 20
          ? "hsl(var(--chart-4))"
          : d.percentage > 5
          ? "hsl(var(--chart-2))"
          : "hsl(var(--chart-3))",
    }));

  const totalMissing = missingData.reduce((sum, d) => sum + d.nullCount, 0);
  const totalCells = totalRows * missingData.length;
  const overallMissingPercentage = totalCells > 0 ? (totalMissing / totalCells) * 100 : 0;
  const columnsWithMissing = missingData.filter((d) => d.nullCount > 0).length;
  const columnsWithHighMissing = missingData.filter((d) => d.percentage > 20).length;

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-destructive/10 rounded-lg flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <div>
            <h3 className="font-semibold">{t("eda.missing.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("eda.missing.description")}
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
              <p className="text-sm">{t("eda.missing.tooltip")}</p>
            </TooltipContent>
          </UITooltip>
        </TooltipProvider>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-muted/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">{t("eda.missing.overallMissing")}</p>
          <p className="text-2xl font-bold">{overallMissingPercentage.toFixed(2)}%</p>
          <Progress
            value={overallMissingPercentage}
            className="mt-2 h-2"
          />
        </div>
        <div className="bg-muted/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">{t("eda.missing.columnsWithMissing")}</p>
          <p className="text-2xl font-bold">
            {columnsWithMissing} <span className="text-sm font-normal text-muted-foreground">/ {missingData.length}</span>
          </p>
        </div>
        <div className="bg-muted/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">{t("eda.missing.highMissingColumns")}</p>
          <p className={`text-2xl font-bold ${columnsWithHighMissing > 0 ? "text-destructive" : "text-green-500"}`}>
            {columnsWithHighMissing}
          </p>
          {columnsWithHighMissing === 0 && (
            <div className="flex items-center gap-1 mt-1">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="text-xs text-green-500">{t("eda.missing.goodQuality")}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 0 ? (
        <div className="mb-6">
          <h4 className="text-sm font-medium mb-3">{t("eda.missing.missingByColumn")}</h4>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
              >
                <CartesianGrid 
                  strokeDasharray="3 3" 
                  stroke="hsl(var(--border))" 
                  strokeOpacity={0.5}
                />
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={{ stroke: "hsl(var(--border))" }}
                />
                <YAxis
                  dataKey="column"
                  type="category"
                  width={95}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={{ stroke: "hsl(var(--border))" }}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
                  }}
                  labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
                  formatter={(value: number, name: string, props: any) => [
                    `${value}% (${props.payload.count.toLocaleString()} ${t("eda.missing.values")})`,
                    props.payload.fullColumn,
                  ]}
                />
                <Bar 
                  dataKey="percentage" 
                  radius={[0, 6, 6, 0]}
                  animationBegin={0}
                  animationDuration={800}
                  animationEasing="ease-out"
                >
                  {chartData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.color}
                      style={{ filter: "brightness(1)", transition: "filter 0.2s ease" }}
                      onMouseEnter={(e: any) => e.target && (e.target.style.filter = "brightness(1.15)")}
                      onMouseLeave={(e: any) => e.target && (e.target.style.filter = "brightness(1)")}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center py-8 mb-6 bg-green-500/5 rounded-lg border border-green-500/20">
          <CheckCircle2 className="w-6 h-6 text-green-500 mr-2" />
          <span className="text-green-500 font-medium">{t("eda.missing.noMissing")}</span>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto max-h-64">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("eda.missing.column")}</TableHead>
              <TableHead>{t("eda.missing.type")}</TableHead>
              <TableHead className="text-right">{t("eda.missing.count")}</TableHead>
              <TableHead className="text-right">{t("eda.missing.percentage")}</TableHead>
              <TableHead>{t("eda.missing.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {missingData.map((item, index) => (
              <TableRow key={index}>
                <TableCell className="font-medium">{item.column}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {item.type}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">{item.nullCount.toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  <span
                    className={
                      item.percentage > 50
                        ? "text-destructive font-medium"
                        : item.percentage > 20
                        ? "text-orange-500"
                        : ""
                    }
                  >
                    {item.percentage.toFixed(2)}%
                  </span>
                </TableCell>
                <TableCell>
                  {item.percentage === 0 ? (
                    <Badge variant="outline" className="text-xs border-green-500 text-green-500">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      {t("eda.missing.complete")}
                    </Badge>
                  ) : item.percentage > 50 ? (
                    <Badge variant="destructive" className="text-xs">
                      {t("eda.missing.critical")}
                    </Badge>
                  ) : item.percentage > 20 ? (
                    <Badge variant="outline" className="text-xs border-orange-500 text-orange-500">
                      {t("eda.missing.attention")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      {t("eda.missing.ok")}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Interpretation */}
      <div className="mt-6 p-4 bg-muted/30 rounded-lg">
        <h4 className="text-sm font-medium mb-2">{t("eda.missing.interpretation")}</h4>
        <p className="text-sm text-muted-foreground">
          {columnsWithHighMissing > 0
            ? t("eda.missing.interpretationHigh", { count: columnsWithHighMissing })
            : columnsWithMissing > 0
            ? t("eda.missing.interpretationLow", { count: columnsWithMissing })
            : t("eda.missing.interpretationNone")}
        </p>
      </div>
    </Card>
  );
};

export default EDAMissingSection;
