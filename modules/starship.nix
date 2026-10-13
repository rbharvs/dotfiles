{
  programs.starship = {
    enable = true;
    enableZshIntegration = false; # Initialized by the live .zshrc.
    settings = {
      format = "$directory$git_branch$git_state$git_status$line_break$character";
      right_format = "$cmd_duration$time";
      character = {
        success_symbol = "[>](green)";
        error_symbol = "[>](red)";
        vimcmd_symbol = "[<](green)";
      };
      directory = {
        style = "blue";
        truncation_length = 0;
        truncate_to_repo = false;
      };
      git_branch = {
        symbol = "";
        style = "green";
        format = "[$branch]($style) ";
      };
      git_state = {
        style = "red";
        format = "[$state( $progress_current/$progress_total)]($style) ";
      };
      git_status = {
        format = "$all_status$ahead_behind";
        conflicted = "[~$count](red) ";
        stashed = "[*$count](green) ";
        deleted = "[-$count](yellow) ";
        renamed = "[r$count](yellow) ";
        modified = "[!$count](yellow) ";
        typechanged = "[t$count](yellow) ";
        staged = "[+$count](yellow) ";
        untracked = "[?$count](blue) ";
        ahead = "[>$count](green) ";
        behind = "[<$count](green) ";
        diverged = "[<$behind_count>$ahead_count](green) ";
      };
      cmd_duration = {
        min_time = 3000;
        style = "yellow";
        format = "[$duration]($style) ";
      };
      time = {
        disabled = false;
        time_format = "%I:%M:%S %p";
        style = "cyan";
        format = "[$time]($style)";
      };
    };
  };
}
