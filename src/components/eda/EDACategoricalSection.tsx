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
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Tags, AlertTriangle, Info } from "lucide-react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CategoricalStat {
  id: string;
  column_name: string;
  distinct_count: number;
  top_categories: { category: string; count: number }[];
}

interface EDACategoricalSectionProps {
  stats: CategoricalStat[];
  totalRows: number;
}

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
  "hsl(var(--chart-7))",
  "hsl(var(--primary))",
  "hsl(var(--secondary))",
  "hsl(var(--accent))",
];

const EDACategoricalSection = ({ stats, totalRows }: EDACategoricalSectionProps) => {
  const { t } = useTranslation();
  const [selectedColumn, setSelectedColumn] = useState<string>(
    stats[0]?.column_name || ""
  );
  const [chartType, setChartType] = useState<"bar" | "pie">("bar");
  const [showTop, setShowTop] = useState<number>(10);

  const selectedData = stats.find((s) => s.column_name === selectedColumn);

  // Calculate if column has high cardinality
  const hasHighCardinality = (stat: CategoricalStat): boolean => {
    return stat.distinct_count > 50;
  };

  // Check if column is imbalanced
  const isImbalanced = (stat: CategoricalStat): boolean => {
    if (stat.top_categories.length < 2) return false;
    const topCount = stat.top_categories[0]?.count || 0;
    const totalInTop = stat.top_categories.reduce((sum, c) => sum + c.count, 0);
    return topCount > totalInTop * 0.8;
  };

  // Prepare chart data with percentage
  const chartData = selectedData
    ? selectedData.top_categories.slice(0, showTop).map((cat, index) => ({
        category: cat.category.length > 20 ? cat.category.slice(0, 17) + "..." : cat.category,
        fullCategory: cat.category,
        count: cat.count,
        percentage: ((cat.count / totalRows) * 100).toFixed(1),
        fill: CHART_COLORS[index % CHART_COLORS.length],
      }))
    : [];

  return (
    <Card className="bg-gradient-card shadow-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-secondary/10 rounded-lg flex items-center justify-center">
            <Tags className="w-5 h-5 text-secondary" />
          </div>
          <div>
            <h3 className="font-semibold">{t("eda.categorical.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("eda.categorical.description")}
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
              <p className="text-sm">{t("eda.categorical.tooltip")}</p>
            </TooltipContent>
          </UITooltip>
        </TooltipProvider>
      </div>

      {/* Summary Table */}
      <div className="mb-6">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("eda.categorical.column")}</TableHead>
                <TableHead className="text-right">{t("eda.categorical.distinctCount")}</TableHead>
                <TableHead>{t("eda.categorical.topCategory")}</TableHead>
                <TableHead className="text-right">{t("eda.categorical.topPercent")}</TableHead>
                <TableHead>{t("eda.categorical.warnings")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((stat) => {
                const topCat = stat.top_categories[0];
                const topPercent = topCat ? ((topCat.count / totalRows) * 100).toFixed(1) : "0";
                return (
                  <TableRow
                    key={stat.id}
                    className={selectedColumn === stat.column_name ? "bg-muted/50" : ""}
                    onClick={() => setSelectedColumn(stat.column_name)}
                    style={{ cursor: "pointer" }}
                  >
                    <TableCell className="font-medium">{stat.column_name}</TableCell>
                    <TableCell className="text-right">{stat.distinct_count}</TableCell>
                    <TableCell>
                      {topCat?.category || "-"}
                      <span className="text-muted-foreground ml-1">
                        ({topCat?.count.toLocaleString() || 0})
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{topPercent}%</TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {hasHighCardinality(stat) && (
                          <Badge variant="outline" className="text-xs border-yellow-500 text-yellow-600">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {t("eda.categorical.highCardinality")}
                          </Badge>
                        )}
                        {isImbalanced(stat) && (
                          <Badge variant="outline" className="text-xs border-orange-500 text-orange-600">
                            {t("eda.categorical.imbalanced")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Chart Section */}
      <div className="pt-6 border-t border-border">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">{t("eda.categorical.viewCategories")}:</span>
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("eda.categorical.showTop")}:</span>
            <Select value={showTop.toString()} onValueChange={(v) => setShowTop(parseInt(v))}>
              <SelectTrigger className="w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="15">15</SelectItem>
                <SelectItem value="20">20</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex border rounded-md">
              <Button
                variant={chartType === "bar" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setChartType("bar")}
                className="rounded-r-none"
              >
                {t("eda.categorical.barChart")}
              </Button>
              <Button
                variant={chartType === "pie" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setChartType("pie")}
                className="rounded-l-none"
              >
                {t("eda.categorical.pieChart")}
              </Button>
            </div>
          </div>
        </div>

        {selectedData && chartData.length > 0 && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === "bar" ? (
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 120, bottom: 5 }}
                >
                  <CartesianGrid 
                    strokeDasharray="3 3" 
                    stroke="hsl(var(--border))" 
                    strokeOpacity={0.5}
                  />
                  <XAxis 
                    type="number" 
                    tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                    tickLine={{ stroke: "hsl(var(--border))" }}
                  />
                  <YAxis
                    dataKey="category"
                    type="category"
                    width={110}
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
                      `${value.toLocaleString()} (${props.payload.percentage}%)`,
                      t("eda.categorical.count"),
                    ]}
                    labelFormatter={(label) => chartData.find(d => d.category === label)?.fullCategory || label}
                  />
                  <Bar 
                    dataKey="count" 
                    radius={[0, 6, 6, 0]}
                    animationBegin={0}
                    animationDuration={800}
                    animationEasing="ease-out"
                  >
                    {chartData.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.fill}
                        style={{ filter: "brightness(1)", transition: "filter 0.2s ease" }}
                        onMouseEnter={(e: any) => e.target && (e.target.style.filter = "brightness(1.15)")}
                        onMouseLeave={(e: any) => e.target && (e.target.style.filter = "brightness(1)")}
                      />
                    ))}
                  </Bar>
                </BarChart>
              ) : (
                <PieChart>
                  <Pie
                    data={chartData}
                    dataKey="count"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    outerRadius={110}
                    innerRadius={40}
                    paddingAngle={2}
                    animationBegin={0}
                    animationDuration={800}
                    animationEasing="ease-out"
                    label={({ category, percentage }) => `${category}: ${percentage}%`}
                    labelLine={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 }}
                  >
                    {chartData.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.fill}
                        stroke="hsl(var(--background))"
                        strokeWidth={2}
                        style={{ filter: "brightness(1)", transition: "filter 0.2s ease" }}
                        onMouseEnter={(e: any) => e.target && (e.target.style.filter = "brightness(1.15)")}
                        onMouseLeave={(e: any) => e.target && (e.target.style.filter = "brightness(1)")}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
                    formatter={(value: number, name: string, props: any) => [
                      `${value.toLocaleString()} (${props.payload.percentage}%)`,
                      props.payload.fullCategory,
                    ]}
                  />
                </PieChart>
              )}
            </ResponsiveContainer>
          </div>
        )}

        {/* Category details table */}
        {selectedData && (
          <div className="mt-4">
            <h4 className="text-sm font-medium mb-2">{t("eda.categorical.detailsFor")} {selectedColumn}</h4>
            <div className="overflow-x-auto max-h-48">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("eda.categorical.category")}</TableHead>
                    <TableHead className="text-right">{t("eda.categorical.count")}</TableHead>
                    <TableHead className="text-right">{t("eda.categorical.percentage")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedData.top_categories.slice(0, showTop).map((cat, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{cat.category}</TableCell>
                      <TableCell className="text-right">{cat.count.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {((cat.count / totalRows) * 100).toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default EDACategoricalSection;
