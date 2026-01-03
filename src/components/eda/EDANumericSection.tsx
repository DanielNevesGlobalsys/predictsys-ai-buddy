import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { TrendingUp, AlertTriangle, Info } from "lucide-react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

interface EDANumericSectionProps {
  stats: NumericStat[];
  totalRows: number;
}

const EDANumericSection = ({ stats, totalRows }: EDANumericSectionProps) => {
  const { t } = useTranslation();
  const [selectedColumn, setSelectedColumn] = useState<string>(
    stats[0]?.column_name || ""
  );
  const [sortBy, setSortBy] = useState<"name" | "missing">("name");

  const formatNumber = (value: number | null): string => {
    if (value === null) return "-";
    if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(2) + "M";
    if (Math.abs(value) >= 1000) return (value / 1000).toFixed(2) + "K";
    return value.toFixed(2);
  };

  const selectedData = stats.find((s) => s.column_name === selectedColumn);

  // Calculate outlier warning based on std and range
  const hasOutlierWarning = (stat: NumericStat): boolean => {
    if (!stat.std_value || !stat.mean_value || !stat.max_value || !stat.min_value) return false;
    const range = stat.max_value - stat.min_value;
    return stat.std_value > range * 0.4; // Rough heuristic
  };

  // Sort stats
  const sortedStats = [...stats].sort((a, b) => {
    if (sortBy === "missing") {
      return b.null_count - a.null_count;
    }
    return a.column_name.localeCompare(b.column_name);
  });

  // Create histogram-like data for the selected column
  const chartData = selectedData
    ? [
        { name: t("eda.numeric.min"), value: selectedData.min_value || 0, color: "hsl(var(--chart-1))" },
        { name: "P25", value: selectedData.min_value && selectedData.median_value 
          ? (selectedData.min_value + selectedData.median_value) / 2 
          : 0, color: "hsl(var(--chart-2))" },
        { name: t("eda.numeric.median"), value: selectedData.median_value || 0, color: "hsl(var(--chart-3))" },
        { name: t("eda.numeric.mean"), value: selectedData.mean_value || 0, color: "hsl(var(--primary))" },
        { name: "P75", value: selectedData.median_value && selectedData.max_value 
          ? (selectedData.median_value + selectedData.max_value) / 2 
          : 0, color: "hsl(var(--chart-4))" },
        { name: t("eda.numeric.max"), value: selectedData.max_value || 0, color: "hsl(var(--chart-5))" },
      ]
    : [];

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">{t("eda.numeric.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("eda.numeric.description")}
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
              <p className="text-sm">{t("eda.numeric.tooltip")}</p>
            </TooltipContent>
          </UITooltip>
        </TooltipProvider>
      </div>

      {/* Stats Table */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-muted-foreground">{t("eda.sortBy")}:</span>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as "name" | "missing")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{t("eda.sortByName")}</SelectItem>
              <SelectItem value="missing">{t("eda.sortByMissing")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("eda.numeric.column")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.min")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.max")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.mean")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.median")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.std")}</TableHead>
                <TableHead className="text-right">{t("eda.numeric.nulls")}</TableHead>
                <TableHead>{t("eda.numeric.warnings")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStats.map((stat) => (
                <TableRow 
                  key={stat.id}
                  className={selectedColumn === stat.column_name ? "bg-muted/50" : ""}
                  onClick={() => setSelectedColumn(stat.column_name)}
                  style={{ cursor: "pointer" }}
                >
                  <TableCell className="font-medium">{stat.column_name}</TableCell>
                  <TableCell className="text-right">{formatNumber(stat.min_value)}</TableCell>
                  <TableCell className="text-right">{formatNumber(stat.max_value)}</TableCell>
                  <TableCell className="text-right">{formatNumber(stat.mean_value)}</TableCell>
                  <TableCell className="text-right">{formatNumber(stat.median_value)}</TableCell>
                  <TableCell className="text-right">{formatNumber(stat.std_value)}</TableCell>
                  <TableCell className="text-right">
                    <span className={stat.null_count > totalRows * 0.1 ? "text-destructive font-medium" : ""}>
                      {stat.null_count}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {hasOutlierWarning(stat) && (
                        <Badge variant="outline" className="text-xs border-yellow-500 text-yellow-600">
                          <AlertTriangle className="w-3 h-3 mr-1" />
                          {t("eda.numeric.outliers")}
                        </Badge>
                      )}
                      {stat.null_count > totalRows * 0.2 && (
                        <Badge variant="outline" className="text-xs border-destructive text-destructive">
                          {t("eda.numeric.highMissing")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Distribution Chart */}
      <div className="pt-6 border-t border-border">
        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm font-medium">{t("eda.numeric.viewDistribution")}:</span>
          <Select value={selectedColumn} onValueChange={setSelectedColumn}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stats.map((stat) => (
                <SelectItem key={stat.column_name} value={stat.column_name}>
                  {stat.column_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedData && (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
              >
                <CartesianGrid 
                  strokeDasharray="3 3" 
                  stroke="hsl(var(--border))" 
                  strokeOpacity={0.5}
                />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={{ stroke: "hsl(var(--border))" }}
                />
                <YAxis 
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
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
                  formatter={(value: number) => [formatNumber(value), t("eda.numeric.value")]}
                />
                <Bar 
                  dataKey="value" 
                  radius={[6, 6, 0, 0]}
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
        )}
      </div>
    </Card>
  );
};

export default EDANumericSection;
