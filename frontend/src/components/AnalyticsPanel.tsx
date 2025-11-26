import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UserPlus, UserMinus, Users, MessageSquare, TrendingUp, CalendarIcon, Award, Download } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import ExcelJS from 'exceljs';

interface AnalyticsData {
  totalMembers: number;
  joined: number;
  left: number;
  messageCount: number;
  activeUsers: number;
  certificates: number;
}

interface Event {
  id: number;
  groupId: string;
  groupName: string;
  memberId: string;
  memberName: string;
  type: 'JOIN' | 'LEAVE' | 'CERTIFICATE';
  timestamp: string;
  date: string;
}

interface AnalyticsPanelProps {
  analytics: AnalyticsData;
  translateMode: boolean;
  onDateFilterChange?: (date: string | null) => void;
  events?: Event[];
  groupName?: string;
  groupId?: string;
}

export function AnalyticsPanel({ analytics, translateMode, onDateFilterChange, events = [], groupName = "All Groups", groupId }: AnalyticsPanelProps) {
  const [mode, setMode] = useState<"all" | "specific" | "period">("specific");
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  const [startDate, setStartDate] = useState<Date>(() => new Date());
  const [endDate, setEndDate] = useState<Date>(() => new Date());
  const [showDialog, setShowDialog] = useState(false);
  const [dialogType, setDialogType] = useState<'JOIN' | 'LEAVE' | 'CERTIFICATE' | 'MEMBERS' | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Notify parent of initial date on mount
  useEffect(() => {
    if (onDateFilterChange) {
      if (mode === "specific" && selectedDate) {
        onDateFilterChange(format(selectedDate, "yyyy-MM-dd"));
      } else if (mode === "period" && startDate && endDate) {
        onDateFilterChange(`${format(startDate, "yyyy-MM-dd")},${format(endDate, "yyyy-MM-dd")}`);
      }
    }
  }, []);

  const handleCardClick = async (type: 'JOIN' | 'LEAVE' | 'CERTIFICATE' | 'MEMBERS') => {
    setDialogType(type);
    setShowDialog(true);

    // Fetch members if MEMBERS type and groupId is available
    if (type === 'MEMBERS' && groupId) {
      setLoadingMembers(true);
      try {
        const response = await fetch(`/api/groups/${groupId}/members`);
        const data = await response.json();
        if (data.success) {
          setMembers(data.members);
        }
      } catch (error) {
        console.error('Error fetching members:', error);
      } finally {
        setLoadingMembers(false);
      }
    }
  };

  const filteredEvents = dialogType ? events.filter(e => e.type === dialogType) : [];

  // Aggregate certificates by member (for display purposes)
  const aggregatedCertificates = dialogType === 'CERTIFICATE' ?
    Object.values(
      filteredEvents.reduce((acc, event) => {
        const key = event.memberId;
        if (!acc[key]) {
          acc[key] = {
            memberId: event.memberId,
            memberName: event.memberName,
            groupId: event.groupId,
            groupName: event.groupName,
            count: 0,
            dates: [] as string[]
          };
        }
        acc[key].count++;
        acc[key].dates.push(event.date);
        return acc;
      }, {} as Record<string, { memberId: string; memberName: string; groupId: string; groupName: string; count: number; dates: string[] }>)
    ).sort((a, b) => b.count - a.count) // Sort by count descending
    : [];

  const handleExportToExcel = async () => {
    if (filteredEvents.length === 0) return;

    // Generate filename based on event type
    const eventTypeName = dialogType === 'JOIN' ? 'Members Joined' :
                          dialogType === 'LEAVE' ? 'Members Left' :
                          'Certificates';
    const eventTypeKey = dialogType === 'JOIN' ? 'Members_Joined' :
                          dialogType === 'LEAVE' ? 'Members_Left' :
                          'Certificates';

    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Events', {
      views: [{ showGridLines: false }]
    });

    // Set column widths based on event type
    if (dialogType === 'CERTIFICATE') {
      worksheet.columns = [
        { width: 35 }, // Name
        { width: 25 }, // Phone Number
        { width: 18 }  // Certificate Count
      ];
    } else {
      worksheet.columns = [
        { width: 35 }, // Name
        { width: 25 }, // Phone Number
        { width: 18 }  // Date
      ];
    }

    // Row 1: Company Name (51Talk) with bright yellow background
    worksheet.mergeCells('A1:C1');
    const titleRow = worksheet.getCell('A1');
    titleRow.value = '51Talk';
    titleRow.font = { name: 'Arial', size: 24, bold: true, color: { argb: 'FF000000' } };
    titleRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFD700' } // Gold/Yellow
    };
    titleRow.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 40;

    // Row 2: Report Subtitle with orange background
    worksheet.mergeCells('A2:C2');
    const subtitleRow = worksheet.getCell('A2');
    subtitleRow.value = 'WhatsApp Analytics Report';
    subtitleRow.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    subtitleRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFF6B35' } // Orange
    };
    subtitleRow.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(2).height = 30;

    // Row 3: Empty
    worksheet.getRow(3).height = 5;

    // Row 4: Group info
    const groupLabelCell = worksheet.getCell('A4');
    groupLabelCell.value = 'Group:';
    groupLabelCell.font = { bold: true, size: 11 };
    groupLabelCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE3F2FD' } // Light blue
    };
    groupLabelCell.alignment = { vertical: 'middle', horizontal: 'right' };

    worksheet.mergeCells('B4:C4');
    const groupValueCell = worksheet.getCell('B4');
    groupValueCell.value = groupName;
    groupValueCell.font = { size: 11 };
    groupValueCell.alignment = { vertical: 'middle', horizontal: 'left' };
    worksheet.getRow(4).height = 22;

    // Row 5: Report Type info
    const typeLabelCell = worksheet.getCell('A5');
    typeLabelCell.value = 'Report Type:';
    typeLabelCell.font = { bold: true, size: 11 };
    typeLabelCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE3F2FD' }
    };
    typeLabelCell.alignment = { vertical: 'middle', horizontal: 'right' };

    worksheet.mergeCells('B5:C5');
    const typeValueCell = worksheet.getCell('B5');
    typeValueCell.value = eventTypeName;
    typeValueCell.font = { size: 11 };
    typeValueCell.alignment = { vertical: 'middle', horizontal: 'left' };
    worksheet.getRow(5).height = 22;

    // Row 6: Generated date info
    const dateLabelCell = worksheet.getCell('A6');
    dateLabelCell.value = 'Generated:';
    dateLabelCell.font = { bold: true, size: 11 };
    dateLabelCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE3F2FD' }
    };
    dateLabelCell.alignment = { vertical: 'middle', horizontal: 'right' };

    worksheet.mergeCells('B6:C6');
    const dateValueCell = worksheet.getCell('B6');
    dateValueCell.value = new Date().toLocaleDateString();
    dateValueCell.font = { size: 11 };
    dateValueCell.alignment = { vertical: 'middle', horizontal: 'left' };
    worksheet.getRow(6).height = 22;

    // Row 7: Empty
    worksheet.getRow(7).height = 5;

    // Row 8: Column Headers with green background
    const headerRow = worksheet.getRow(8);
    if (dialogType === 'CERTIFICATE') {
      headerRow.values = ['Name', 'Phone Number', 'Certificate Count'];
    } else {
      headerRow.values = ['Name', 'Phone Number', 'Date'];
    }
    headerRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4CAF50' } // Green
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 30;

    // Add borders to header
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF000000' } },
        bottom: { style: 'medium', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } }
      };
    });

    // Add data rows with alternating yellow colors
    if (dialogType === 'CERTIFICATE') {
      // For certificates, export aggregated data with counts
      aggregatedCertificates.forEach((cert, index) => {
        const rowNumber = 9 + index;
        const row = worksheet.getRow(rowNumber);
        row.values = [cert.memberName, cert.memberId, cert.count];

        const isEven = index % 2 === 0;
        const bgColor = isEven ? 'FFFFF9C4' : 'FFFFFDE7'; // Light yellow shades

        row.eachCell((cell, colNumber) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: bgColor }
          };
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber === 3 ? 'center' : 'left'
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
          };
          cell.font = { size: 11 };
        });

        row.height = 20;
      });
    } else {
      // For JOIN/LEAVE events, export individual events
      filteredEvents.forEach((event, index) => {
        const rowNumber = 9 + index;
        const row = worksheet.getRow(rowNumber);
        row.values = [event.memberName, event.memberId, event.date];

        const isEven = index % 2 === 0;
        const bgColor = isEven ? 'FFFFF9C4' : 'FFFFFDE7'; // Light yellow shades

        row.eachCell((cell, colNumber) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: bgColor }
          };
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber === 3 ? 'center' : 'left'
          };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
            right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
          };
          cell.font = { size: 11 };
        });

        row.height = 20;
      });
    }

    // Generate filename
    const filename = `51Talk_${eventTypeKey}_${groupName.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;

    // Write to buffer and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const stats = [
    {
      title: translateMode ? "总成员" : "Total Members",
      value: analytics.totalMembers,
      icon: Users,
      color: "text-primary",
      clickable: true,
      onClick: () => handleCardClick('MEMBERS'),
    },
    {
      title: translateMode ? "加入成员" : "Members Joined",
      value: `+${analytics.joined}`,
      icon: UserPlus,
      color: "text-primary",
      clickable: true,
      onClick: () => handleCardClick('JOIN'),
    },
    {
      title: translateMode ? "离开成员" : "Members Left",
      value: `-${analytics.left}`,
      icon: UserMinus,
      color: "text-destructive",
      clickable: true,
      onClick: () => handleCardClick('LEAVE'),
    },
    {
      title: translateMode ? "总消息数" : "Total Messages",
      value: analytics.messageCount,
      icon: MessageSquare,
      color: "text-foreground",
      clickable: false,
    },
    {
      title: translateMode ? "活跃用户" : "Active Users",
      value: analytics.activeUsers,
      icon: TrendingUp,
      color: "text-primary",
      clickable: false,
    },
    {
      title: translateMode ? "证书" : "Certificates",
      value: analytics.certificates,
      icon: Award,
      color: "text-primary",
      clickable: true,
      onClick: () => handleCardClick('CERTIFICATE'),
    },
  ];

  return (
    <div className="h-full border-l border-border bg-card overflow-y-auto">
      <div className="p-4 border-b border-border space-y-3">
        <h2 className="text-lg font-semibold text-foreground">
          {translateMode ? "分析" : "Analytics"}
        </h2>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant={mode === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setMode("all");
              onDateFilterChange?.(null);
            }}
          >
            {translateMode ? "全部" : "All"}
          </Button>
          <Button
            variant={mode === "specific" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setMode("specific");
              if (selectedDate) {
                onDateFilterChange?.(format(selectedDate, "yyyy-MM-dd"));
              }
            }}
          >
            {translateMode ? "单日" : "Day"}
          </Button>
          <Button
            variant={mode === "period" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setMode("period");
              if (startDate && endDate) {
                onDateFilterChange?.(`${format(startDate, "yyyy-MM-dd")},${format(endDate, "yyyy-MM-dd")}`);
              }
            }}
          >
            {translateMode ? "期间" : "Period"}
          </Button>
        </div>
        {mode === "specific" && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal",
                  !selectedDate && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {selectedDate ? (
                  format(selectedDate, "PPP")
                ) : (
                  <span>{translateMode ? "选择日期" : "Pick a date"}</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => {
                  setSelectedDate(date);
                  if (date && mode === "specific") {
                    onDateFilterChange?.(format(date, "yyyy-MM-dd"));
                  }
                }}
                initialFocus
                className="p-3 pointer-events-auto"
                modifiers={{
                  today: new Date()
                }}
                modifiersClassNames={{
                  today: "bg-blue-500 text-white hover:bg-blue-600"
                }}
              />
            </PopoverContent>
          </Popover>
        )}
        {mode === "period" && (
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                {translateMode ? "开始日期" : "Start Date"}
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !startDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {startDate ? (
                      format(startDate, "PPP")
                    ) : (
                      <span>{translateMode ? "选择开始日期" : "Pick start date"}</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={(date) => {
                      if (date) {
                        setStartDate(date);
                        if (mode === "period" && endDate) {
                          onDateFilterChange?.(`${format(date, "yyyy-MM-dd")},${format(endDate, "yyyy-MM-dd")}`);
                        }
                      }
                    }}
                    initialFocus
                    className="p-3 pointer-events-auto"
                    modifiers={{
                      today: new Date()
                    }}
                    modifiersClassNames={{
                      today: "bg-blue-500 text-white hover:bg-blue-600"
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                {translateMode ? "结束日期" : "End Date"}
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !endDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {endDate ? (
                      format(endDate, "PPP")
                    ) : (
                      <span>{translateMode ? "选择结束日期" : "Pick end date"}</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={(date) => {
                      if (date) {
                        setEndDate(date);
                        if (mode === "period" && startDate) {
                          onDateFilterChange?.(`${format(startDate, "yyyy-MM-dd")},${format(date, "yyyy-MM-dd")}`);
                        }
                      }
                    }}
                    initialFocus
                    className="p-3 pointer-events-auto"
                    modifiers={{
                      today: new Date()
                    }}
                    modifiersClassNames={{
                      today: "bg-blue-500 text-white hover:bg-blue-600"
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        )}
      </div>
      <div className="p-4 space-y-4">
        {stats.map((stat) => (
          <Card
            key={stat.title}
            className={cn(
              "border-border",
              stat.clickable && "cursor-pointer hover:bg-accent transition-colors"
            )}
            onClick={stat.clickable ? stat.onClick : undefined}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                {stat.title}
                <stat.icon className={cn("h-4 w-4", stat.color)} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn("text-2xl font-bold", stat.color)}>{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>
                {dialogType === 'JOIN'
                  ? (translateMode ? "加入成员" : "Members Joined")
                  : dialogType === 'LEAVE'
                  ? (translateMode ? "离开成员" : "Members Left")
                  : dialogType === 'MEMBERS'
                  ? (translateMode ? "所有成员" : "All Members")
                  : (translateMode ? "证书" : "Certificates")
                }
              </DialogTitle>
              {dialogType !== 'MEMBERS' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportToExcel}
                  disabled={dialogType === 'CERTIFICATE' ? aggregatedCertificates.length === 0 : filteredEvents.length === 0}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  {translateMode ? "导出" : "Export"}
                </Button>
              )}
            </div>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {dialogType === 'MEMBERS' ? (
              loadingMembers ? (
                <p className="text-center text-muted-foreground py-8">
                  {translateMode ? "加载中..." : "Loading..."}
                </p>
              ) : members.length > 0 ? (
                <div className="space-y-2">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="p-3 border border-border rounded-lg hover:bg-accent transition-colors"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="font-medium text-foreground">
                            {member.name}
                            {member.isAdmin && (
                              <span className="ml-2 text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded">
                                {translateMode ? "管理员" : "Admin"}
                              </span>
                            )}
                          </p>
                          <p className="text-sm text-primary mt-1">{member.phone}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  {translateMode ? "没有数据" : "No members found"}
                </p>
              )
            ) : dialogType === 'CERTIFICATE' && aggregatedCertificates.length > 0 ? (
              <div className="space-y-2">
                {aggregatedCertificates.map((cert) => (
                  <div
                    key={cert.memberId}
                    className="p-3 border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <p className="font-medium text-foreground">
                          {cert.memberName}
                          <span className="ml-2 text-primary font-bold">
                            ({cert.count} {translateMode ? '证书' : cert.count === 1 ? 'certificate' : 'certificates'})
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">{cert.memberId}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {translateMode ? '日期: ' : 'Dates: '}
                          {cert.dates.sort().join(', ')}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : dialogType !== 'CERTIFICATE' && dialogType !== 'MEMBERS' && filteredEvents.length > 0 ? (
              <div className="space-y-2">
                {filteredEvents.map((event) => (
                  <div
                    key={event.id}
                    className="p-3 border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{event.memberName}</p>
                        <p className="text-xs text-muted-foreground mt-1">{event.memberId}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">{event.date}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">
                {translateMode ? "没有数据" : "No data"}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

